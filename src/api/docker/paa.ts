/**
 * Start / stop the PAA container for a PA benchmark job.
 *
 * Modelled on `withAgent` — starts the container, polls until healthy,
 * runs a callback, then tears it down regardless of outcome.
 */

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetch } from "undici";
import type { AgentOutcome, JobContext } from "../benchmarks/types.ts";
import type { Job, ModelConfig } from "../../shared/types.ts";
import { API_URL, JOB_DATA_TTL_S, RESOURCES_DIR } from "../config.ts";
import { docker, JOB_LABEL, PAA_CONTAINER_PREFIX, sleep } from "./cli.ts";
import {
	MOCK_CALLS_PATH,
	MOCK_CONTROL_PORT,
	PAA_CHAT_PORT,
	PAA_INFO_PATH,
	PAA_HEALTH_PATH,
	WORLD_DIR_IN_CONTAINER,
	type PaaProfile,
	type ToolCallRecord,
} from "../../pa/constants.ts";
import { keys } from "../queue/store.ts";
import { redis } from "../redis.ts";
import { proxyBaseUrl } from "../routes/llm.ts";

const TOOL_CALLS_FETCH_TIMEOUT_MS = 10_000;

export interface PaaOptions {
	/** The job-scoped LLM proxy token for the PAA container. */
	llmToken: string;
	/** The per-job internal network; the only network the PAA joins. */
	network: string;
	/** The job's model; only its API format and limits reach the container, never its key. */
	model: ModelConfig;
	/** The assistant's image, scratch directory and user (`PAA_PROFILES`). */
	profile: PaaProfile;
	worldId: string;
	/** The scenario date (from world.yaml); injected so the PAA knows "today". */
	executionDate: string;
}

/** Saves the mock services' tool-call log for scoring. Over the job network, before the container stops. */
async function saveToolCalls(jobId: string, host: string): Promise<void> {
	try {
		const res = await fetch(`http://${host}:${MOCK_CONTROL_PORT}${MOCK_CALLS_PATH}`, {
			signal: AbortSignal.timeout(TOOL_CALLS_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`status ${res.status}`);
		const calls = (await res.json()) as ToolCallRecord[];
		if (!Array.isArray(calls)) throw new Error("not a list");
		await redis.set(keys.paToolCalls(jobId), JSON.stringify(calls), "EX", JOB_DATA_TTL_S);
		console.log(`[docker] ${host}: saved ${calls.length} tool call(s)`);
	} catch (err) {
		console.error(`[docker] ${host}: could not fetch the tool-call log: ${err}`);
	}
}

/** Saves the assistant's version and enabled toolsets, which its entrypoint wrote at startup. */
async function savePaaInfo(jobId: string, name: string): Promise<void> {
	try {
		const info = await docker("exec", name, "cat", PAA_INFO_PATH);
		JSON.parse(info);
		await redis.set(keys.paInfo(jobId), info, "EX", JOB_DATA_TTL_S);
	} catch (err) {
		console.error(`[docker] ${name}: could not read the assistant info: ${err}`);
	}
}

/** Polls `check` every `intervalMs` until truthy or ctx expires; an error from `check` ends the wait. */
async function poll(check: () => Promise<boolean>, intervalMs: number, ctx: JobContext): Promise<boolean> {
	while (true) {
		if (await ctx.cancelled()) return false;
		if (Date.now() > ctx.deadline) return false;
		if (await check()) return true;
		await sleep(intervalMs);
	}
}

/**
 * Streams the world's `world.yaml` and `agent/` (never `grading.yaml`) into the
 * container's scratch directory, then marks it ready for the entrypoint.
 * `docker cp` can't write to a container with a read-only root filesystem.
 */
async function copyWorld(hostWorldDir: string, name: string, scratchDir: string): Promise<void> {
	await promisify(execFile)("bash", [
		"-o", "pipefail", "-c",
		`tar -C "$1" -cf - agent world.yaml | docker exec -i "$2" sh -c 'mkdir -p "$1" && tar -x -C "$1"' sh "$3" && docker exec "$2" touch "$3/.ready"`,
		"copy-world", hostWorldDir, name, `${scratchDir}/world`,
	]);
}

/**
 * Starts the PAA container for `job`, copies the world in, waits until
 * healthy, runs `use`, then removes the container.
 */
export async function withPaa(
	job: Job,
	ctx: JobContext,
	{ llmToken, network, model, profile, worldId, executionDate }: PaaOptions,
	use: () => Promise<AgentOutcome>,
): Promise<AgentOutcome> {
	const name = `${PAA_CONTAINER_PREFIX}${job.id}`;
	const log = (msg: string) => console.log(`[docker] ${name}: ${msg}`);

	const gatewayToken = randomBytes(24).toString("hex");
	const hostWorldDir = `${RESOURCES_DIR}/pa/worlds/${worldId}`;
	let started = false;

	const env = [
		// The assistant talks to the model in its own API format (LLM_API below), so it follows the same URL rule as the pi agent.
		["LLM_BASE_URL", proxyBaseUrl(API_URL, model.api)],
		["LLM_TOKEN", llmToken],
		["LLM_API", model.api],
		["LLM_CONTEXT_WINDOW", model.contextWindow?.toString()],
		["LLM_MAX_TOKENS", model.maxTokens?.toString()],
		["PAA_GATEWAY_TOKEN", gatewayToken],
		["WORLD_DIR", WORLD_DIR_IN_CONTAINER],
		// The scenario date so the PAA (and chat adapter) know "today" without a tool call.
		["EXECUTION_DATE", executionDate],
	].flatMap(([k, v]) => (v ? ["-e", `${k}=${v}`] : []));

	try {
		log("starting PAA container");
		await docker(
			"run", "-d",
			"--name", name,
			"--label", `${JOB_LABEL}=${job.id}`,
			"--network", network,
			"--read-only",
			"--tmpfs", `${profile.scratchDir}:uid=${profile.uid},gid=${profile.uid}`,
			"--tmpfs", `/tmp:uid=${profile.uid},gid=${profile.uid}`,
			...env,
			profile.image,
		);
		started = true;
		await copyWorld(hostWorldDir, name, profile.scratchDir);

		log("waiting for the assistant to be healthy");
		const healthy = await poll(
			async () => {
				if ((await docker("inspect", "-f", "{{.State.Running}}", name)) !== "true") {
					throw new Error("PAA container exited during startup");
				}
				const res = await fetch(`http://${name}:${PAA_CHAT_PORT}${PAA_HEALTH_PATH}`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
				return res?.ok ?? false;
			},
			2000,
			ctx,
		);
		if (!healthy) {
			log("PAA did not become healthy in time");
			return { status: "error", error: "PAA container did not become healthy" };
		}
		log("PAA container healthy");

		return await use();
	} finally {
		if (started) {
				await saveToolCalls(job.id, name);
				await savePaaInfo(job.id, name);
			}
		// Capture PAA logs (chat adapter, the assistant, mock services) before removal.
		try {
			const { stdout, stderr } = await promisify(execFile)("docker", ["logs", "--tail", "50", name]);
			const combined = (stderr || stdout || "").trim();
			if (combined) {
				for (const line of combined.split("\n")) {
					if (line.trim()) console.error(`[paa-log] ${name}: ${line}`);
				}
			}
		} catch { /* container may already be gone */ }
		await docker("stop", "--time", "10", name)
			.then(() => docker("rm", name))
			.then(() => log("container removed"))
			.catch((err) => console.error(`[docker] cleanup of ${name} failed: ${err}`));
	}
}
