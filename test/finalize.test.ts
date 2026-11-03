import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readModelFile } from "../src/api/db/modelFiles.ts";
import { listRuns, openDb } from "../src/api/db/runs.ts";
import { finalizeRun } from "../src/api/finalize.ts";
import type { ResultPayload } from "../src/shared/results.ts";
import type { Job } from "../src/shared/types.ts";

const job: Job = {
	id: "j1",
	benchmark: "cyber",
	prompt: "p",
	model: "gpt-x",
	params: { challenge: "locktalk" },
	status: "done",
	createdAt: "2026-11-03T00:00:00.000Z",
};
const metrics = { turns: 4, durationMs: 2000, inputTokens: 100, outputTokens: 50, costUsd: 0.25 };

const setup = (result?: ResultPayload) => {
	const db = openDb(":memory:");
	const resultsDir = mkdtempSync(join(tmpdir(), "fin-"));
	return {
		db,
		resultsDir,
		deps: {
			db,
			resultsDir,
			getResult: async () => result,
			modelIdFor: () => "gpt-x-2026",
			conditions: { maxTurns: 50, jobTimeoutMs: 1800000 },
		},
	};
};

test("a reported result becomes a row and a model-file entry", async () => {
	const { db, resultsDir, deps } = setup({ outcome: { correct: true }, metrics, sessionId: "s1" });
	const run = await finalizeRun(deps, job, { status: "done" }, { waitMs: 0 });
	assert.equal(run.correct, true);
	const [row] = listRuns(db, {});
	assert.equal(row.challenge, "locktalk");
	assert.equal(row.sessionId, "s1");
	assert.equal(row.modelId, "gpt-x-2026");
	assert.deepEqual(row.metrics, metrics);
	assert.equal((await readModelFile(resultsDir, "cyber", "gpt-x"))?.runs.length, 1);
});

test("an incorrect outcome is stored as correct=false, a missing flag as null", async () => {
	const a = setup({ outcome: { correct: false }, metrics });
	assert.equal((await finalizeRun(a.deps, job, { status: "done" }, { waitMs: 0 })).correct, false);
	const b = setup({ outcome: null, metrics });
	assert.equal((await finalizeRun(b.deps, job, { status: "done" }, { waitMs: 0 })).correct, null);
});

test("an errored job with no result still gets a row with a null outcome", async () => {
	const { db, deps } = setup(undefined);
	const run = await finalizeRun(deps, { ...job, id: "j2" }, { status: "error", error: "timed out" }, { waitMs: 0 });
	assert.equal(run.status, "error");
	assert.equal(run.outcome, null);
	assert.equal(run.correct, null);
	assert.equal(run.metrics.turns, 0);
	assert.equal(listRuns(db, {}).length, 1);
});

test("finalizing the same job twice writes no duplicate", async () => {
	const { db, resultsDir, deps } = setup({ outcome: { correct: true }, metrics });
	await finalizeRun(deps, job, { status: "done" }, { waitMs: 0 });
	await finalizeRun(deps, job, { status: "done" }, { waitMs: 0 });
	assert.equal(listRuns(db, {}).length, 1);
	assert.equal((await readModelFile(resultsDir, "cyber", "gpt-x"))?.runs.length, 1);
});

test("finalizeRun waits for a result that arrives late", async () => {
	let calls = 0;
	const { deps } = setup();
	deps.getResult = async () => (++calls >= 3 ? { outcome: { correct: true }, metrics } : undefined);
	const run = await finalizeRun(deps, job, { status: "done" }, { waitMs: 2000, pollMs: 5 });
	assert.equal(run.correct, true);
});
