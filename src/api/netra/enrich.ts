import type { DatabaseSync } from "node:sqlite";
import type { RunRecord } from "../../shared/results.ts";
import { updateRunInFile } from "../db/modelFiles.ts";
import { updateNetraMetadata } from "../db/runs.ts";

export interface NetraClient {
	/** Session totals and traces; undefined while the session is not visible in Netra yet. */
	sessionDetails(sessionId: string): Promise<{ traceIds: string[]; data: unknown } | undefined>;
}

export interface EnrichDeps {
	db: DatabaseSync;
	resultsDir: string;
	client: NetraClient;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Pulls a finished run's Netra session data and saves it as `netra_metadata` (SQLite and the model's JSON file).
 * Polls because traces land in Netra after the agent flushes. Failure is logged and returns false; it never
 * touches the stored result and never throws.
 */
export async function enrichRun(
	{ db, resultsDir, client, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }: EnrichDeps,
	run: RunRecord,
	{ attempts = 10, delayMs = 15_000 }: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
	if (!run.sessionId) return false;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const details = await client.sessionDetails(run.sessionId);
			if (details) {
				updateNetraMetadata(db, run.jobId, details.data, details.traceIds);
				await updateRunInFile(resultsDir, { ...run, netraMetadata: details.data, traceIds: details.traceIds });
				console.log(`[netra] job ${run.jobId}: stored session insights (${details.traceIds.length} trace(s))`);
				return true;
			}
		} catch (err) {
			console.error(`[netra] job ${run.jobId}: attempt ${attempt}/${attempts} failed: ${err}`);
		}
		if (attempt < attempts) await sleep(delayMs);
	}
	console.error(`[netra] job ${run.jobId}: no Netra data after ${attempts} attempt(s); result kept without insights`);
	return false;
}
