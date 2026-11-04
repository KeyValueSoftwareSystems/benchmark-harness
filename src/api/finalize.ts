import type { DatabaseSync } from "node:sqlite";
import type { ResultPayload, RunRecord } from "../shared/results.ts";
import type { Job } from "../shared/types.ts";
import type { AgentOutcome } from "./benchmarks/types.ts";
import { upsertRunInFile } from "./db/modelFiles.ts";
import { upsertRun } from "./db/runs.ts";

export interface FinalizeDeps {
	db: DatabaseSync;
	resultsDir: string;
	getResult: (jobId: string) => Promise<ResultPayload | undefined>;
	modelIdFor: (model: string) => string;
	conditions: Record<string, unknown>;
	/** Writes the run to its model file; defaults to the real writer (injectable for tests). */
	writeRun?: (dir: string, run: RunRecord) => Promise<void>;
}

const EMPTY_METRICS = { turns: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The agent posts its result just before the job settles, so give a late one a moment to land. */
async function waitForResult(deps: FinalizeDeps, jobId: string, waitMs: number, pollMs: number) {
	const deadline = Date.now() + waitMs;
	while (true) {
		const result = await deps.getResult(jobId);
		if (result || Date.now() >= deadline) return result;
		await sleep(pollMs);
	}
}

/**
 * Writes a settled job to SQLite and to its model's JSON file. Benchmark-agnostic: `outcome` is whatever the
 * benchmark reported (`correct` is read from it when it is a boolean). A re-run of the same job replaces the earlier
 * attempt in both stores; calling it twice for one attempt is harmless.
 */
export async function finalizeRun(
	deps: FinalizeDeps,
	job: Job,
	outcome: AgentOutcome,
	{
		waitMs = 5000,
		pollMs = 250,
		writeAttempts = 3,
		writeDelayMs = 200,
	}: { waitMs?: number; pollMs?: number; writeAttempts?: number; writeDelayMs?: number } = {},
): Promise<RunRecord> {
	const result = await waitForResult(deps, job.id, waitMs, pollMs);
	const reported = result?.outcome ?? null;
	const run: RunRecord = {
		jobId: job.id,
		benchmark: job.benchmark,
		model: job.model,
		modelId: deps.modelIdFor(job.model),
		challenge: job.params?.challenge ?? null,
		status: outcome.status,
		correct: typeof reported?.correct === "boolean" ? reported.correct : null,
		outcome: reported,
		metrics: result?.metrics ?? EMPTY_METRICS,
		sessionId: result?.sessionId ?? null,
		traceIds: null,
		netraMetadata: null,
		conditions: deps.conditions,
		createdAt: job.createdAt,
		finishedAt: new Date().toISOString(),
	};
	upsertRun(deps.db, run);
	const write = deps.writeRun ?? upsertRunInFile;
	for (let attempt = 1; ; attempt++) {
		try {
			await write(deps.resultsDir, run);
			break;
		} catch (err) {
			// SQLite already has the run; a failed file write is retried, and `reconcileModelFiles` heals what is left.
			if (attempt >= writeAttempts) throw err;
			await sleep(writeDelayMs);
		}
	}
	return run;
}
