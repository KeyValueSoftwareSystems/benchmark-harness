import { execFile } from "node:child_process";
import { promisify } from "node:util";

const docker = (...args: string[]) => promisify(execFile)("docker", args).then((r) => r.stdout.trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LABEL = "bench.job";
const AGENT_PORT = 8080;
const NETWORK = process.env.AGENT_NETWORK ?? "bench";
const FORWARDED_ENV = ["NETRA_OTLP_ENDPOINT", "NETRA_API_KEY", "NETRA_ENV", "NETRA_DEBUG"];

export interface AgentOutcome {
	status: "done" | "error" | "cancelled";
	error?: string;
}

/** Removes agent containers left behind by a previous API instance. */
export async function sweep() {
	const ids = await docker("ps", "-aq", "--filter", `label=${LABEL}`);
	if (!ids) return;
	const list = ids.split("\n");
	await docker("rm", "-f", ...list);
	console.log(`[containers] removed ${list.length} leftover agent container(s)`);
}

/** Polls `check` every `intervalMs` until it returns a value, the job is cancelled, or the deadline passes. */
async function poll<T>(
	check: () => Promise<T | undefined>,
	{ intervalMs, deadline, cancelled }: { intervalMs: number; deadline: number; cancelled: () => Promise<boolean> },
): Promise<T | AgentOutcome> {
	while (true) {
		if (await cancelled()) return { status: "cancelled" };
		if (Date.now() > deadline) return { status: "error", error: "timed out" };
		const result = await check().catch(() => undefined);
		if (result !== undefined) return result;
		await sleep(intervalMs);
	}
}

/** Runs `prompt` on a fresh agent container for `benchmark`, and removes the container afterwards. */
export async function runAgent(opts: {
	jobId: string;
	benchmark: string;
	prompt: string;
	apiUrl: string;
	timeoutMs: number;
	cancelled: () => Promise<boolean>;
	onRunning?: () => Promise<void>;
}): Promise<AgentOutcome> {
	const name = `agent-${opts.jobId}`;
	const url = `http://${name}:${AGENT_PORT}`;
	const waiting = { deadline: Date.now() + opts.timeoutMs, cancelled: opts.cancelled };
	const env = [
		["JOB_ID", opts.jobId],
		["API_URL", opts.apiUrl],
		["BENCHMARK", opts.benchmark],
		...FORWARDED_ENV.filter((k) => process.env[k]).map((k) => [k, process.env[k] as string]),
	].flatMap(([k, v]) => ["-e", `${k}=${v}`]);

	const log = (msg: string) => console.log(`[containers] ${name}: ${msg}`);
	const startedAt = Date.now();

	try {
		log(`starting bench/${opts.benchmark}`);
		await docker(
			"run", "-d", "--name", name, "--label", `${LABEL}=${opts.jobId}`, "--network", NETWORK,
			"--add-host", "host.docker.internal:host-gateway", ...env, `bench/${opts.benchmark}`,
		);

		const ready = await poll(async () => ((await fetch(`${url}/healthz`)).ok ? true : undefined), { ...waiting, intervalMs: 1000 });
		if (ready !== true) return ready;
		log("agent ready, sending prompt");

		const started = await fetch(`${url}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: opts.prompt }),
		});
		if (!started.ok) return { status: "error", error: `agent /run returned ${started.status}` };
		await opts.onRunning?.();
		log("agent running");

		const outcome = await poll<AgentOutcome>(
			async () => {
				const state = (await (await fetch(`${url}/state`)).json()) as { status: string; error?: string };
				if (state.status === "done") return { status: "done" };
				if (state.status === "error") return { status: "error", error: state.error };
			},
			{ ...waiting, intervalMs: 2000 },
		);
		log(`${outcome.status} after ${Math.round((Date.now() - startedAt) / 1000)}s${outcome.error ? `: ${outcome.error}` : ""}`);
		return outcome;
	} finally {
		// Stop gracefully (SIGTERM) first so the agent can flush its traces; `rm -f` would kill it outright.
		await docker("stop", "--time", "30", name)
			.then(() => docker("rm", name))
			.then(() => log("container removed"))
			.catch((err) => console.error(`[containers] cleanup of ${name} failed: ${err}`));
	}
}
