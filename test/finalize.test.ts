import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readModelFile, upsertRunInFile } from "../src/api/db/modelFiles.ts";
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
			writeRun: upsertRunInFile,
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

test("a re-run of the same job replaces the first result in SQLite and in the file", async () => {
	const { db, resultsDir, deps } = setup({ outcome: { correct: false }, metrics });
	await finalizeRun(deps, job, { status: "done" }, { waitMs: 0 });
	deps.getResult = async () => ({ outcome: { correct: true }, metrics, sessionId: "s2" });
	await finalizeRun(deps, job, { status: "done" }, { waitMs: 0 });
	const rows = listRuns(db, {});
	assert.deepEqual(rows.map((r) => [r.correct, r.sessionId]), [[true, "s2"]]);
	const runs = (await readModelFile(resultsDir, "cyber", "gpt-x"))?.runs ?? [];
	assert.deepEqual(runs.map((r) => r.correct), [true]);
});

test("a failing file write is retried, so the run still reaches the JSON", async () => {
	const { db, resultsDir, deps } = setup({ outcome: { correct: true }, metrics });
	let calls = 0;
	const write = deps.writeRun;
	deps.writeRun = async (dir, run) => {
		if (++calls < 3) throw new Error("disk full");
		await write(dir, run);
	};
	await finalizeRun(deps, job, { status: "done" }, { waitMs: 0, writeDelayMs: 1 });
	assert.equal(calls, 3);
	assert.equal((await readModelFile(resultsDir, "cyber", "gpt-x"))?.runs.length, 1);
	assert.equal(listRuns(db, {}).length, 1);
});

test("a benchmark's score hook overrides the reported verdict, outcome, metrics, session and assistant", async () => {
	const { db, deps } = setup({ outcome: { verdict: "satisfied" }, metrics, sessionId: "persona-session" });
	const scored = { turns: 9, durationMs: 5000, inputTokens: 900, outputTokens: 90, costUsd: 0.02 };
	let seen: unknown;
	const run = await finalizeRun(
		{
			...deps,
			benchmark: {
				score: async (j, result) => {
					seen = [j.id, result?.sessionId];
					return { correct: true, outcome: { verdict: "satisfied", score: { total: 0.8 } }, metrics: scored, sessionId: "trace-session", assistant: "openclaw" };
				},
			},
		},
		job,
		{ status: "done" },
		{ waitMs: 0 },
	);
	assert.deepEqual(seen, ["j1", "persona-session"]);
	assert.deepEqual([run.correct, run.sessionId, run.assistant], [true, "trace-session", "openclaw"]);
	assert.deepEqual(run.metrics, scored);
	const [row] = listRuns(db, {});
	assert.deepEqual(row.outcome, { verdict: "satisfied", score: { total: 0.8 } });
	assert.equal(row.assistant, "openclaw");
});

test("fields the score hook leaves out keep what the agent reported", async () => {
	const { deps } = setup({ outcome: { correct: false }, metrics, sessionId: "s1" });
	const run = await finalizeRun({ ...deps, benchmark: { score: async () => ({ correct: null }) } }, job, { status: "done" }, { waitMs: 0 });
	assert.deepEqual([run.correct, run.sessionId, run.outcome], [null, "s1", { correct: false }]);
	assert.deepEqual(run.metrics, metrics);
});

test("a throwing score hook still saves the run, unscored", async () => {
	const { db, deps } = setup({ outcome: { correct: true }, metrics });
	const run = await finalizeRun(
		{ ...deps, benchmark: { score: async () => Promise.reject(new Error("judge exploded")) } },
		job,
		{ status: "done" },
		{ waitMs: 0 },
	);
	assert.equal(run.correct, true);
	assert.deepEqual(run.outcome, { correct: true });
	assert.equal(listRuns(db, {}).length, 1);
});

test("cyber and minimal have no score hook, so their runs are stored as before", async () => {
	process.env.MGMT_KEY ??= "test";
	process.env.API_CONTAINER_NAME ??= "test";
	const { cyber } = await import("../src/api/benchmarks/cyber.ts");
	const { minimal } = await import("../src/api/benchmarks/minimal.ts");
	assert.equal(cyber.score, undefined);
	assert.equal(minimal.score, undefined);
	const { deps } = setup({ outcome: { correct: true }, metrics, sessionId: "s1" });
	const run = await finalizeRun({ ...deps, benchmark: cyber }, job, { status: "done" }, { waitMs: 0 });
	assert.deepEqual([run.correct, run.sessionId, run.assistant], [true, "s1", null]);
});

test("a file write that keeps failing surfaces the error but keeps the SQLite row", async () => {
	const { db, deps } = setup({ outcome: { correct: true }, metrics });
	deps.writeRun = async () => {
		throw new Error("disk full");
	};
	await assert.rejects(finalizeRun(deps, job, { status: "done" }, { waitMs: 0, writeDelayMs: 1 }), /disk full/);
	assert.equal(listRuns(db, {}).length, 1);
});
