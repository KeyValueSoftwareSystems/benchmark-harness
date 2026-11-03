import assert from "node:assert/strict";
import test from "node:test";
import { insertRun, listRuns, openDb, updateNetraMetadata } from "../src/api/db/runs.ts";
import type { RunRecord } from "../src/shared/results.ts";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
	jobId: "job1",
	benchmark: "cyber",
	model: "gpt-x",
	modelId: "gpt-x-2026",
	challenge: "locktalk",
	status: "done",
	correct: true,
	outcome: { correct: true },
	metrics: { turns: 3, durationMs: 1000, inputTokens: 10, outputTokens: 5, costUsd: 0.1 },
	sessionId: "s1",
	traceIds: null,
	netraMetadata: null,
	conditions: { maxTurns: 50 },
	createdAt: "2026-11-03T00:00:00.000Z",
	finishedAt: "2026-11-03T00:01:00.000Z",
	...over,
});

test("insertRun returns true for a new job and false for a repeat", () => {
	const db = openDb(":memory:");
	assert.equal(insertRun(db, run()), true);
	assert.equal(insertRun(db, run()), false);
	assert.equal(listRuns(db, {}).length, 1);
});

test("listRuns filters by benchmark and model and round-trips fields", () => {
	const db = openDb(":memory:");
	insertRun(db, run({ jobId: "a" }));
	insertRun(db, run({ jobId: "b", benchmark: "minimal", model: "other", correct: null, outcome: null }));
	assert.deepEqual(listRuns(db, { benchmark: "cyber" }).map((r) => r.jobId), ["a"]);
	assert.deepEqual(listRuns(db, { model: "other" }).map((r) => r.jobId), ["b"]);
	const [a] = listRuns(db, { benchmark: "cyber" });
	assert.equal(a.correct, true);
	assert.deepEqual(a.metrics.turns, 3);
	const [b] = listRuns(db, { model: "other" });
	assert.equal(b.correct, null);
	assert.equal(b.outcome, null);
});

test("updateNetraMetadata stores metadata and trace ids", () => {
	const db = openDb(":memory:");
	insertRun(db, run());
	updateNetraMetadata(db, "job1", { spans: 4 }, ["t1", "t2"]);
	const [r] = listRuns(db, {});
	assert.deepEqual(r.netraMetadata, { spans: 4 });
	assert.deepEqual(r.traceIds, ["t1", "t2"]);
});

test("openDb uses the delete journal mode so a read-only mount works", async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const db = openDb(join(mkdtempSync(join(tmpdir(), "db-")), "h.db"));
	const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
	assert.equal(row.journal_mode, "delete");
});
