import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRun, readModelFile, updateRunInFile } from "../src/api/db/modelFiles.ts";
import type { RunRecord } from "../src/shared/results.ts";
import { slug } from "../src/shared/results.ts";

const run = (jobId: string, model = "gpt-x"): RunRecord => ({
	jobId,
	benchmark: "cyber",
	model,
	modelId: "m",
	challenge: null,
	status: "done",
	correct: true,
	outcome: null,
	metrics: { turns: 1, durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
	sessionId: null,
	traceIds: null,
	netraMetadata: null,
	conditions: {},
	createdAt: "2026-11-03T00:00:00.000Z",
	finishedAt: "2026-11-03T00:00:01.000Z",
});

const tmp = () => mkdtempSync(join(tmpdir(), "mf-"));

test("concurrent appendRun calls for one model keep both runs", async () => {
	const dir = tmp();
	await Promise.all([appendRun(dir, run("a")), appendRun(dir, run("b"))]);
	const file = await readModelFile(dir, "cyber", "gpt-x");
	assert.deepEqual(file?.runs.map((r) => r.jobId).sort(), ["a", "b"]);
});

test("a hostile model name stays inside the results dir under a sanitized name", async () => {
	const dir = tmp();
	await appendRun(dir, run("a", "../evil/x y"));
	assert.equal(slug("../evil/x y"), "evil-x-y");
	assert.deepEqual(readdirSync(join(dir, "cyber")), ["evil-x-y.json"]);
});

test("appendRun ignores a job already in the file", async () => {
	const dir = tmp();
	await appendRun(dir, run("a"));
	await appendRun(dir, run("a"));
	assert.equal((await readModelFile(dir, "cyber", "gpt-x"))?.runs.length, 1);
});

test("updateRunInFile replaces the run with the same job id", async () => {
	const dir = tmp();
	await appendRun(dir, run("a"));
	await updateRunInFile(dir, { ...run("a"), netraMetadata: { x: 1 } });
	assert.deepEqual((await readModelFile(dir, "cyber", "gpt-x"))?.runs[0].netraMetadata, { x: 1 });
});

test("readModelFile returns undefined when there is no file", async () => {
	assert.equal(await readModelFile(tmp(), "cyber", "nope"), undefined);
});
