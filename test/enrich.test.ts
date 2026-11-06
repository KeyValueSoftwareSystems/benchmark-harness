import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readModelFile, upsertRunInFile } from "../src/api/db/modelFiles.ts";
import { listRuns, openDb, upsertRun } from "../src/api/db/runs.ts";
import { enrichRun } from "../src/api/netra/enrich.ts";
import type { RunRecord } from "../src/shared/results.ts";

const base: RunRecord = {
	jobId: "j1",
	benchmark: "cyber",
	model: "gpt-x",
	modelId: "m",
	challenge: null,
	status: "done",
	correct: true,
	outcome: null,
	metrics: { turns: 1, durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
	sessionId: "sess-1",
	traceIds: null,
	netraMetadata: null,
	conditions: {},
	createdAt: "2026-11-03T00:00:00.000Z",
	finishedAt: "2026-11-03T00:00:01.000Z",
};

async function setup(run: RunRecord = base) {
	const db = openDb(":memory:");
	const resultsDir = mkdtempSync(join(tmpdir(), "en-"));
	upsertRun(db, run);
	await upsertRunInFile(resultsDir, run);
	return { db, resultsDir };
}

test("retries until the session is visible, then stores metadata in sqlite and the model file", async () => {
	const { db, resultsDir } = await setup();
	let calls = 0;
	const client = { sessionDetails: async () => (++calls < 3 ? undefined : { traceIds: ["t1", "t2"], data: { spans: 4 } }) };
	const ok = await enrichRun({ db, resultsDir, client, sleep: async () => {} }, base, { attempts: 5, delayMs: 1 });
	assert.equal(ok, true);
	assert.equal(calls, 3);
	const [row] = listRuns(db, {});
	assert.deepEqual(row.netraMetadata, { spans: 4 });
	assert.deepEqual(row.traceIds, ["t1", "t2"]);
	assert.deepEqual((await readModelFile(resultsDir, "cyber", "gpt-x"))?.runs[0].traceIds, ["t1", "t2"]);
});

test("a client that always throws leaves metadata null and does not throw", async () => {
	const { db, resultsDir } = await setup();
	const client = {
		sessionDetails: async () => {
			throw new Error("mcp down");
		},
	};
	const ok = await enrichRun({ db, resultsDir, client, sleep: async () => {} }, base, { attempts: 3, delayMs: 1 });
	assert.equal(ok, false);
	assert.equal(listRuns(db, {})[0].netraMetadata, null);
});

test("a run without a session id is skipped immediately", async () => {
	const run = { ...base, sessionId: null };
	const { db, resultsDir } = await setup(run);
	let calls = 0;
	const client = { sessionDetails: async () => (calls++, undefined) };
	assert.equal(await enrichRun({ db, resultsDir, client, sleep: async () => {} }, run), false);
	assert.equal(calls, 0);
});

test("enrichment from an earlier attempt is dropped once the job has been re-run", async () => {
	const { db, resultsDir } = await setup();
	const rerun = { ...base, sessionId: "sess-2", correct: false };
	upsertRun(db, rerun);
	await upsertRunInFile(resultsDir, rerun);
	const client = { sessionDetails: async () => ({ traceIds: ["old"], data: { stale: true } }) };
	assert.equal(await enrichRun({ db, resultsDir, client, sleep: async () => {} }, base, { attempts: 1 }), false);
	assert.equal(listRuns(db, {})[0].netraMetadata, null);
	assert.equal((await readModelFile(resultsDir, "cyber", "gpt-x"))?.runs[0].netraMetadata, null);
});
