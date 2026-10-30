import { API_URL } from "../config.ts";
import type { AgentOutcome, JobContext } from "../benchmarks/types.ts";
import type { Job } from "../../shared/types.ts";
import { docker, JOB_LABEL, sleep } from "./cli.ts";

const AGENT_PORT = 8080;
const NETWORK = process.env.AGENT_NETWORK ?? "bench";
const FORWARDED_ENV = ["NETRA_OTLP_ENDPOINT", "NETRA_API_KEY", "NETRA_ENV", "NETRA_DEBUG", "MAX_TURNS"];

export interface Agent {
	/** Sends `prompt` and waits for the agent to finish. */
	run(prompt: string): Promise<AgentOutcome>;
}

/** Polls `check` every `intervalMs` until it returns a value, the job is cancelled, or the deadline passes. */
async function poll<T>(check: () => Promise<T | undefined>, intervalMs: number, ctx: JobContext): Promise<T | AgentOutcome> {
	while (true) {
		if (await ctx.cancelled()) return { status: "cancelled" };
		if (Date.now() > ctx.deadline) return { status: "error", error: "timed out" };
		const result = await check().catch(() => undefined);
		if (result !== undefined) return result;
		await sleep(intervalMs);
	}
}

/** Starts the job's agent container (image `bench/<benchmark>`), runs `use` against it, then removes it. */
export interface AgentOptions {
	/** Extra networks to join besides the one shared with the api (e.g. a challenge's project network). */
	networks?: string[];
	/** Directory on the api host to copy into the container before the agent starts. */
	files?: { from: string; to: string };
}

export async function withAgent(
	job: Job,
	ctx: JobContext,
	use: (agent: Agent) => Promise<AgentOutcome>,
	{ networks = [], files }: AgentOptions = {},
): Promise<AgentOutcome> {
	const name = `agent-${job.id}`;
	const url = `http://${name}:${AGENT_PORT}`;
	const log = (msg: string) => console.log(`[docker] ${name}: ${msg}`);
	const env = [
		["JOB_ID", job.id],
		["API_URL", API_URL],
		["BENCHMARK", job.benchmark],
		...FORWARDED_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k] as string]),
	].flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	const startedAt = Date.now();

	try {
		log(`starting bench/${job.benchmark}`);
		await docker(
			"run", "-d", "--name", name, "--label", `${JOB_LABEL}=${job.id}`, "--network", NETWORK,
			"--add-host", "host.docker.internal:host-gateway", ...env, `bench/${job.benchmark}`,
		);
		for (const network of networks) await docker("network", "connect", network, name);
		if (files) await docker("cp", `${files.from}/.`, `${name}:${files.to}`);
		const ready = await poll(async () => ((await fetch(`${url}/healthz`)).ok ? true : undefined), 1000, ctx);
		if (ready !== true) return ready;
		log("agent ready");

		const outcome = await use({
			async run(prompt) {
				const started = await fetch(`${url}/run`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ prompt }),
				});
				if (!started.ok) return { status: "error", error: `agent /run returned ${started.status}` };
				await ctx.setStatus("running");
				log("agent running");
				return poll<AgentOutcome>(
					async () => {
						const state = (await (await fetch(`${url}/state`)).json()) as { status: string; error?: string };
						if (state.status === "done") return { status: "done" };
						if (state.status === "error") return { status: "error", error: state.error };
					},
					2000,
					ctx,
				);
			},
		});
		log(`${outcome.status} after ${Math.round((Date.now() - startedAt) / 1000)}s${outcome.error ? `: ${outcome.error}` : ""}`);
		return outcome;
	} finally {
		// Stop gracefully (SIGTERM) first so the agent can flush its traces; `rm -f` would kill it outright.
		await docker("stop", "--time", "30", name)
			.then(() => docker("rm", name))
			.then(() => log("container removed"))
			.catch((err) => console.error(`[docker] cleanup of ${name} failed: ${err}`));
	}
}
