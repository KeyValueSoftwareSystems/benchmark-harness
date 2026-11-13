import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readModelFile, updateRunInFile, upsertRunInFile } from "../src/api/db/modelFiles.ts";
import type { RunRecord } from "../src/shared/results.ts";
import { slug } from "../src/shared/results.ts";

const run = (jobId: string, model = "gpt-x"): RunRecord => ({
	jobId,
	benchmark: "cyber",
	model,
	modelId: "m",
	challenge: null,
	assistant: null,
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

test("concurrent upsertRunInFile calls for one model keep both runs", async () => {
	const dir = tmp();
	await Promise.all([upsertRunInFile(dir, run("a")), upsertRunInFile(dir, run("b"))]);
	const file = await readModelFile(dir, "cyber", "gpt-x");
	assert.deepEqual(file?.runs.map((r) => r.jobId).sort(), ["a", "b"]);
});

test("a hostile model name stays inside the results dir under a sanitized name", async () => {
	const dir = tmp();
	await upsertRunInFile(dir, run("a", "../evil/x y"));
	assert.equal(slug("../evil/x y"), "evil-x-y");
	assert.deepEqual(readdirSync(join(dir, "cyber")), ["evil-x-y.json"]);
});

test("a re-run of a job replaces its entry in the file instead of being dropped", async () => {
	const dir = tmp();
	await upsertRunInFile(dir, { ...run("a"), correct: false });
	await upsertRunInFile(dir, { ...run("a"), correct: true });
	const runs = (await readModelFile(dir, "cyber", "gpt-x"))?.runs ?? [];
	assert.deepEqual(runs.map((r) => [r.jobId, r.correct]), [["a", true]]);
});

test("updateRunInFile does not overwrite a newer attempt (different session)", async () => {
	const dir = tmp();
	await upsertRunInFile(dir, { ...run("a"), sessionId: "s2" });
	await updateRunInFile(dir, { ...run("a"), sessionId: "s1", netraMetadata: { stale: 1 } });
	assert.equal((await readModelFile(dir, "cyber", "gpt-x"))?.runs[0].netraMetadata, null);
});

test("updateRunInFile replaces the run with the same job id", async () => {
	const dir = tmp();
	await upsertRunInFile(dir, run("a"));
	await updateRunInFile(dir, { ...run("a"), netraMetadata: { x: 1 } });
	assert.deepEqual((await readModelFile(dir, "cyber", "gpt-x"))?.runs[0].netraMetadata, { x: 1 });
});

test("an entry written before runs had an assistant reads back with assistant null", async () => {
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const dir = tmp();
	const { assistant: _omitted, ...old } = run("old");
	mkdirSync(join(dir, "cyber"));
	writeFileSync(join(dir, "cyber", "gpt-x.json"), JSON.stringify({ benchmark: "cyber", model: "gpt-x", modelId: "m", runs: [old] }));
	assert.equal((await readModelFile(dir, "cyber", "gpt-x"))?.runs[0].assistant, null);
});

test("readModelFile returns undefined when there is no file", async () => {
	assert.equal(await readModelFile(tmp(), "cyber", "nope"), undefined);
});
