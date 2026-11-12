import { benchmarks } from "./benchmarks/index.ts";
import type { AgentOutcome, JobContext } from "./benchmarks/types.ts";
import { CONDITIONS, JOB_TIMEOUT_MS, NETRA_API_KEY, NETRA_MCP_ENDPOINT, RESULTS_DIR } from "./config.ts";
import { db } from "./db/instance.ts";
import { finalizeRun } from "./finalize.ts";
import { keyError, registry } from "./models/registry.ts";
import { enrichRun } from "./netra/enrich.ts";
import { createNetraClient } from "./netra/mcp.ts";
import { getJob, getResult, isCancelRequested, resetContextClaim, setStatus } from "./queue/store.ts";
import { redis } from "./redis.ts";

/** Runs one queued job on its benchmark's handler and records the outcome. */
export async function runJob(id: string) {
	const job = await getJob(redis, id);
	if (!job || job.status === "done" || job.status === "error" || job.status === "cancelled") return;
	if (await isCancelRequested(redis, id)) {
		console.log(`[api] job ${id} cancelled before start`);
		return void (await setStatus(redis, id, "cancelled"));
	}
	const benchmark = benchmarks.get(job.benchmark);
	if (!benchmark) return void (await setStatus(redis, id, "error", `unknown benchmark ${job.benchmark}`));

	const missingKey = keyError(registry, job.model);
	if (missingKey) {
		console.error(`[api] job ${id}: ${missingKey} (${job.model})`);
		return void (await setStatus(redis, id, "error", missingKey));
	}

	const ctx: JobContext = {
		deadline: Date.now() + JOB_TIMEOUT_MS,
		cancelled: () => isCancelRequested(redis, id),
		setStatus: (status) => setStatus(redis, id, status),
	};
	await resetContextClaim(redis, id);
	await setStatus(redis, id, "provisioning");
	console.log(`[api] job ${id} (${job.benchmark}, ${job.model}) provisioning`);
	const outcome = await benchmark.run(job, ctx).catch((err): AgentOutcome => ({ status: "error", error: String(err) }));
	await setStatus(redis, id, outcome.status, outcome.error);
	console.log(`[api] job ${id} ${outcome.status}`);

	// Store the result before Netra sees the final data; never let a storage problem change the job's status.
	try {
		const run = await finalizeRun(
			{
				db,
				resultsDir: RESULTS_DIR,
				getResult: (jobId) => getResult(redis, jobId),
				modelIdFor: (name) => registry.find(name)?.modelId ?? name,
				conditions: CONDITIONS,
			},
			job,
			outcome,
		);
		// Insights arrive once Netra has the trace; run in the background and never block the queue.
		if (NETRA_API_KEY) {
			const client = createNetraClient(NETRA_MCP_ENDPOINT, NETRA_API_KEY);
			void enrichRun({ db, resultsDir: RESULTS_DIR, client }, run);
		}
	} catch (err) {
		console.error(`[api] job ${id}: could not store result: ${err}`);
	}
}
