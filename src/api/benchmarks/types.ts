import type { Job, JobStatus } from "../../shared/types.ts";

export interface AgentOutcome {
	status: "done" | "error" | "cancelled";
	error?: string;
}

/** What a benchmark needs from the runner while it handles one job. */
export interface JobContext {
	/** Epoch ms after which the job counts as timed out. */
	deadline: number;
	cancelled(): Promise<boolean>;
	setStatus(status: JobStatus): Promise<void>;
}

export interface JobInput {
	prompt: string;
	params?: Record<string, string>;
}

/**
 * One benchmark's way of handling a job. `run` owns everything it provisions (agent, targets, ...)
 * and must tear it all down before returning, whatever the outcome.
 */
export interface Benchmark {
	name: string;
	/** Default for how many of this benchmark's jobs run at once (`CONCURRENCY_<NAME>` overrides it). */
	concurrency: number;
	/** Validates a `POST /jobs` body and turns it into the inputs of the jobs to create (one per challenge, say). */
	parse(body: Record<string, unknown>): Promise<JobInput[] | { error: string }>;
	/** What the agent's extension asks for at startup (served once per run). */
	context?(job: Job): Promise<unknown>;
	run(job: Job, ctx: JobContext): Promise<AgentOutcome>;
}
