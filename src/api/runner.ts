import { benchmarks } from "./benchmarks/index.ts";
import type { AgentOutcome, JobContext } from "./benchmarks/types.ts";
import { JOB_TIMEOUT_MS } from "./config.ts";
import { getJob, isCancelRequested, resetContextClaim, setStatus } from "./queue/store.ts";
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
}
