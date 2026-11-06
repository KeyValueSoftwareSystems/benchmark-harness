/**
 * Start / stop the PAA container for a PA benchmark job.
 *
 * Modelled on `withAgent` — starts the container, polls until healthy,
 * runs a callback, then tears it down regardless of outcome.
 */

import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentOutcome, JobContext } from "../benchmarks/types.ts";
import type { Job, ModelConfig } from "../../shared/types.ts";
import { API_URL, RESOURCES_DIR } from "../config.ts";
import { docker, JOB_LABEL, PAA_CONTAINER_PREFIX, sleep } from "./cli.ts";
import { WORLD_DIR_IN_CONTAINER } from "../../pa/constants.ts";
import { proxyBaseUrl } from "../routes/llm.ts";

const PAA_IMAGE = "bench/pa-paa";
const OPENCLAW_PORT = 18789;
/** The only writable path in the container (OpenClaw's state), owned by the image's `node` user. */
const SCRATCH_DIR = "/home/node/.openclaw";
/** A symlink in the image to `${SCRATCH_DIR}/world`. */

export interface PaaOptions {
	/** The job-scoped LLM proxy token for the PAA container. */
	llmToken: string;
	/** The per-job internal network; the only network the PAA joins. */
	network: string;
	/** The job's model; only its API format and limits reach the container, never its key. */
	model: ModelConfig;
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
async function copyWorld(hostWorldDir: string, name: string): Promise<void> {
	await promisify(execFile)("bash", [
		"-o", "pipefail", "-c",
		`tar -C "$1" -cf - agent world.yaml | docker exec -i "$2" sh -c 'mkdir -p "$1" && tar -x -C "$1"' sh "$3" && docker exec "$2" touch "$3/.ready"`,
		"copy-world", hostWorldDir, name, `${SCRATCH_DIR}/world`,
	]);
}

/**
 * Starts the PAA container for `job`, copies the world in, waits until
 * healthy, runs `use`, then removes the container.
 */
export async function withPaa(
	job: Job,
	ctx: JobContext,
	{ llmToken, network, model }: PaaOptions,
	use: () => Promise<AgentOutcome>,
): Promise<AgentOutcome> {
	const name = `${PAA_CONTAINER_PREFIX}${job.id}`;
	const log = (msg: string) => console.log(`[docker] ${name}: ${msg}`);

	const openclawToken = randomBytes(24).toString("hex");
	const worldId = job.params?.world ?? "";
	const hostWorldDir = `${RESOURCES_DIR}/pa/worlds/${worldId}`;

	const env = [
		// OpenClaw talks to the model in its own API format (LLM_API below), so it follows the same URL rule as the pi agent.
		["LLM_BASE_URL", proxyBaseUrl(API_URL, model.api)],
		["LLM_TOKEN", llmToken],
		["LLM_API", model.api],
		["LLM_CONTEXT_WINDOW", model.contextWindow?.toString()],
		["LLM_MAX_TOKENS", model.maxTokens?.toString()],
		["OPENCLAW_GATEWAY_TOKEN", openclawToken],
		["WORLD_DIR", WORLD_DIR_IN_CONTAINER],
	].flatMap(([k, v]) => (v ? ["-e", `${k}=${v}`] : []));

	try {
		log("starting PAA container");
		await docker(
			"run", "-d",
			"--name", name,
			"--label", `${JOB_LABEL}=${job.id}`,
			"--network", network,
			"--read-only",
			"--tmpfs", `${SCRATCH_DIR}:uid=1000,gid=1000`,
			...env,
			PAA_IMAGE,
		);
		await copyWorld(hostWorldDir, name);

		log("waiting for OpenClaw gateway to be healthy");
		const healthy = await poll(
			async () => {
				if ((await docker("inspect", "-f", "{{.State.Running}}", name)) !== "true") {
					throw new Error("PAA container exited during startup");
				}
				const out = await docker(
					"exec", name, "curl", "-sf", `http://localhost:${OPENCLAW_PORT}/healthz`,
				).catch(() => "");
				return out.length > 0;
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
		// Capture PAA logs (chat adapter, OpenClaw, mock services) before removal.
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
