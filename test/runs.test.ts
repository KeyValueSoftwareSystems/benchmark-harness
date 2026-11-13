import assert from "node:assert/strict";
import test from "node:test";
import { listRuns, openDb, updateNetraMetadata, upsertRun } from "../src/api/db/runs.ts";
import type { RunRecord } from "../src/shared/results.ts";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
	jobId: "job1",
	benchmark: "cyber",
	model: "gpt-x",
	modelId: "gpt-x-2026",
	challenge: "locktalk",
	assistant: null,
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

test("upserting the same run twice leaves one row", () => {
	const db = openDb(":memory:");
	upsertRun(db, run());
	upsertRun(db, run());
	assert.equal(listRuns(db, {}).length, 1);
});

test("a re-run of the same job replaces the first attempt, including its old Netra data", () => {
	const db = openDb(":memory:");
	upsertRun(db, run({ correct: true, sessionId: "s1", traceIds: ["t1"], netraMetadata: { old: 1 } }));
	upsertRun(db, run({ correct: false, sessionId: "s2", traceIds: null, netraMetadata: null }));
	const rows = listRuns(db, {});
	assert.equal(rows.length, 1);
	assert.deepEqual([rows[0].correct, rows[0].sessionId, rows[0].traceIds, rows[0].netraMetadata], [false, "s2", null, null]);
});

test("listRuns filters by benchmark and model and round-trips fields", () => {
	const db = openDb(":memory:");
	upsertRun(db, run({ jobId: "a" }));
	upsertRun(db, run({ jobId: "b", benchmark: "minimal", model: "other", correct: null, outcome: null }));
	assert.deepEqual(listRuns(db, { benchmark: "cyber" }).map((r) => r.jobId), ["a"]);
	assert.deepEqual(listRuns(db, { model: "other" }).map((r) => r.jobId), ["b"]);
	const [a] = listRuns(db, { benchmark: "cyber" });
	assert.equal(a.correct, true);
	assert.deepEqual(a.metrics.turns, 3);
	const [b] = listRuns(db, { model: "other" });
	assert.equal(b.correct, null);
	assert.equal(b.outcome, null);
});

test("updateNetraMetadata stores metadata and trace ids for the run's own session", () => {
	const db = openDb(":memory:");
	upsertRun(db, run());
	assert.equal(updateNetraMetadata(db, "job1", "s1", { spans: 4 }, ["t1", "t2"]), true);
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

test("updateNetraMetadata ignores a stale session: a newer attempt's row is left alone", () => {
	const db = openDb(":memory:");
	upsertRun(db, run({ sessionId: "s2" }));
	assert.equal(updateNetraMetadata(db, "job1", "s1", { spans: 4 }, ["t1"]), false);
	assert.equal(listRuns(db, {})[0].netraMetadata, null);
});

test("the assistant column is added to a database created before it existed, and values round-trip", async () => {
	const { DatabaseSync } = await import("node:sqlite");
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const file = join(mkdtempSync(join(tmpdir(), "db-")), "old.db");
	const old = new DatabaseSync(file);
	old.exec(`CREATE TABLE runs (job_id TEXT PRIMARY KEY, benchmark TEXT NOT NULL, model TEXT NOT NULL, model_id TEXT NOT NULL,
		challenge TEXT, status TEXT NOT NULL, correct INTEGER, outcome TEXT, metrics TEXT NOT NULL, session_id TEXT, trace_ids TEXT,
		netra_metadata TEXT, conditions TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT NOT NULL)`);
	old.exec(`INSERT INTO runs VALUES ('legacy', 'cyber', 'gpt-x', 'g', 'c', 'done', 1, NULL, '{"turns":1,"durationMs":1,"inputTokens":1,"outputTokens":1,"costUsd":0}', NULL, NULL, NULL, '{}', '2026-01-01', '2026-01-01')`);
	old.close();

	const db = openDb(file);
	upsertRun(db, run({ jobId: "pa1", benchmark: "pa", assistant: "openclaw" }));
	const byId = new Map(listRuns(db, {}).map((r) => [r.jobId, r]));
	assert.equal(byId.get("legacy")?.assistant, null);
	assert.equal(byId.get("pa1")?.assistant, "openclaw");
	db.close();
	// Opening again is a no-op for the schema.
	assert.equal(listRuns(openDb(file), {}).length, 2);
});

test("re-saving the same attempt keeps the Netra data already stored for its session", () => {
	const db = openDb(":memory:");
	upsertRun(db, run({ sessionId: "s1" }));
	updateNetraMetadata(db, "job1", "s1", { spans: 4 }, ["t1"]);
	upsertRun(db, run({ sessionId: "s1" }));
	const [r] = listRuns(db, {});
	assert.deepEqual([r.netraMetadata, r.traceIds], [{ spans: 4 }, ["t1"]]);
});
