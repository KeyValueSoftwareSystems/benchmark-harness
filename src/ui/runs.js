import { api } from "./api.js";
import { groupRuns, newestFirst } from "./state.js";

// The page's view of runs: the job list grouped into runs (newest first) plus each job's verdict.
// Verdicts of a settled run never change, so they are fetched once; running runs are re-read on every load.

export const verdicts = new Map(); // jobId -> true | false | null
const settled = new Set(); // runIds whose verdicts are final
const reads = new Map(); // runId -> how many times it was read after it finished
let latest = [];

export const currentRuns = () => latest;

export async function loadRuns() {
	const runs = newestFirst(groupRuns(await api.jobs()));
	await Promise.all(
		runs
			.filter((r) => !settled.has(r.runId))
			.map(async (r) => {
				const detail = await api.run(r.runId).catch(() => undefined);
				for (const j of detail?.jobs ?? []) verdicts.set(j.id, j.correct);
				// A verdict can land a moment after its job settles, so a finished run is read once more before it counts as final.
				if (r.status !== "running" && detail) {
					const seen = (reads.get(r.runId) ?? 0) + 1;
					reads.set(r.runId, seen);
					if (seen >= 2 || detail.jobs.every((j) => j.status !== "done" || j.correct !== null)) settled.add(r.runId);
				}
			}),
	);
	latest = runs;
	return runs;
}

/** The newest run of a model, if it has one. */
export const lastRunOf = (model) => latest.find((r) => r.model === model);
