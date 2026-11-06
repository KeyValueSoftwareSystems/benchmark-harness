import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readModelFile, upsertRunInFile } from "../src/api/db/modelFiles.ts";
import { reconcileModelFiles } from "../src/api/db/reconcile.ts";
import { openDb, upsertRun } from "../src/api/db/runs.ts";
import type { RunRecord } from "../src/shared/results.ts";

const run = (jobId: string, over: Partial<RunRecord> = {}): RunRecord => ({
	jobId,
	benchmark: "cyber",
	model: "gpt-x",
	modelId: "m",
	challenge: jobId,
	status: "done",
	correct: true,
	outcome: null,
	metrics: { turns: 1, durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
	sessionId: "s",
	traceIds: null,
	netraMetadata: null,
	conditions: {},
	createdAt: "x",
	finishedAt: "y",
	...over,
});

test("a run that is in SQLite but missing from its model file is added", async () => {
	const db = openDb(":memory:");
	const dir = mkdtempSync(join(tmpdir(), "rec-"));
	upsertRun(db, run("a"));
	upsertRun(db, run("b"));
	await upsertRunInFile(dir, run("a"));
	assert.equal(await reconcileModelFiles(db, dir), 1);
	assert.deepEqual((await readModelFile(dir, "cyber", "gpt-x"))?.runs.map((r) => r.jobId).sort(), ["a", "b"]);
});

test("a stale file entry is replaced with the SQLite version, and a second pass changes nothing", async () => {
	const db = openDb(":memory:");
	const dir = mkdtempSync(join(tmpdir(), "rec-"));
	upsertRun(db, run("a", { correct: true, sessionId: "s2" }));
	await upsertRunInFile(dir, run("a", { correct: false, sessionId: "s1" }));
	assert.equal(await reconcileModelFiles(db, dir), 1);
	assert.equal((await readModelFile(dir, "cyber", "gpt-x"))?.runs[0].correct, true);
	assert.equal(await reconcileModelFiles(db, dir), 0);
});

test("an empty database reconciles to nothing", async () => {
	assert.equal(await reconcileModelFiles(openDb(":memory:"), mkdtempSync(join(tmpdir(), "rec-"))), 0);
});
