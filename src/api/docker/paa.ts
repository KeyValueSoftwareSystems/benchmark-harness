/**
 * Start / stop the PAA container for a PA benchmark job.
 *
 * Modelled on `withAgent` — starts the container, polls until healthy,
 * runs a callback, then tears it down regardless of outcome.
 */

import { randomBytes } from "node:crypto";
import type { AgentOutcome, JobContext } from "../benchmarks/types.ts";
import type { Job } from "../../shared/types.ts";
import { API_URL, RESOURCES_DIR } from "../config.ts";
import { docker, JOB_LABEL, sleep } from "./cli.ts";

const PAA_IMAGE = "bench/pa-paa";
const OPENCLAW_PORT = 18789;
const NETWORK = process.env.AGENT_NETWORK ?? "bench";

export interface PaaOptions {
	/** The job-scoped LLM proxy token for the PAA container. */
	llmToken: string;
	/** Extra networks to join (e.g. a per-job internal network). */
	networks?: string[];
}

/** Polls `check` every `intervalMs` until truthy or ctx expires. */
async function poll(check: () => Promise<boolean>, intervalMs: number, ctx: JobContext): Promise<boolean> {
	while (true) {
		if (await ctx.cancelled()) return false;
		if (Date.now() > ctx.deadline) return false;
		if (await check().catch(() => false)) return true;
		await sleep(intervalMs);
	}
}

/**
 * Starts the PAA container for `job`, waits until healthy, runs `use`,
 * then removes the container.  The world directory is bind-mounted at
 * `/pa/world` so the mock services and entrypoint can read world.yaml
 * and agent/fixtures.
 */
export async function withPaa(
	job: Job,
	ctx: JobContext,
	{ llmToken, networks = [] }: PaaOptions,
	use: () => Promise<AgentOutcome>,
): Promise<AgentOutcome> {
	const name = `paa-job-${job.id}`;
	const log = (msg: string) => console.log(`[docker] ${name}: ${msg}`);

	const openclawToken = randomBytes(24).toString("hex");
	const worldId = job.params?.world ?? "";
	const hostWorldDir = `${RESOURCES_DIR}/pa/worlds/${worldId}`;

	const env = [
		"-e", `LLM_BASE_URL=${API_URL}/llm/v1`,
		"-e", `LLM_TOKEN=${llmToken}`,
		"-e", `OPENCLAW_GATEWAY_TOKEN=${openclawToken}`,
		"-e", "WORLD_DIR=/pa/world",
	];

	try {
		log("starting PAA container");
		await docker(
			"run", "-d",
			"--name", name,
			"--label", `${JOB_LABEL}=${job.id}`,
			"--network", NETWORK,
			"--read-only",
			"--tmpfs", "/tmp",
			"--tmpfs", "/home/node/.openclaw",
			"-v", `${hostWorldDir}:/pa/world:ro`,
			...env,
			PAA_IMAGE,
		);
		for (const net of networks) await docker("network", "connect", net, name);

		log("waiting for OpenClaw gateway to be healthy");
		const healthy = await poll(
			async () => {
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
		await docker("stop", "--time", "10", name)
			.then(() => docker("rm", name))
			.then(() => log("container removed"))
			.catch((err) => console.error(`[docker] cleanup of ${name} failed: ${err}`));
	}
}
