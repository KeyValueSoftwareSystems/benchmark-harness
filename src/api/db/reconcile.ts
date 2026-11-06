import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { readModelFile, upsertRunInFile } from "./modelFiles.ts";
import { listRuns } from "./runs.ts";

/**
 * SQLite is the source of truth; the per-model JSON files are what reports read. After a crash or a failed write a run
 * can be in SQLite but missing from (or stale in) its file, so this brings the files back in line. Returns how many
 * entries it had to write.
 */
export async function reconcileModelFiles(db: DatabaseSync, dir: string): Promise<number> {
	let fixed = 0;
	for (const run of listRuns(db, {})) {
		const existing = (await readModelFile(dir, run.benchmark, run.model))?.runs.find((r) => r.jobId === run.jobId);
		if (existing && isDeepStrictEqual(existing, run)) continue;
		await upsertRunInFile(dir, run);
		fixed++;
	}
	return fixed;
}
