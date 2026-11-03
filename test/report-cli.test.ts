import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendRun } from "../src/api/db/modelFiles.ts";
import { generateReport } from "../src/reports/generate.ts";
import type { RunRecord } from "../src/shared/results.ts";

const run = (model: string, jobId: string, challenge: string, correct: boolean): RunRecord => ({
	jobId,
	benchmark: "cyber",
	model,
	modelId: "m",
	challenge,
	status: "done",
	correct,
	outcome: null,
	metrics: { turns: 1, durationMs: 120_000, inputTokens: 1, outputTokens: 1, costUsd: 0.5 },
	sessionId: null,
	traceIds: null,
	netraMetadata: null,
	conditions: { maxTurns: 50, jobTimeoutMs: 1_800_000 },
	createdAt: "x",
	finishedAt: "y",
});

async function fixture() {
	const resultsDir = mkdtempSync(join(tmpdir(), "res-"));
	const reportsDir = join(mkdtempSync(join(tmpdir(), "rep-")), "out");
	for (const m of ["alpha", "beta"]) {
		await appendRun(resultsDir, run(m, `${m}1`, "c1", true));
		await appendRun(resultsDir, run(m, `${m}2`, "c2", m === "alpha"));
	}
	return { resultsDir, reportsDir };
}

test("writes an html report and a json sidecar for the chosen models", async () => {
	const f = await fixture();
	const out = await generateReport({ benchmark: "cyber", models: ["alpha", "beta"], ...f });
	assert.ok(existsSync(out.htmlPath) && existsSync(out.jsonPath));
	const sidecar = JSON.parse(readFileSync(out.jsonPath, "utf8"));
	assert.equal(sidecar.benchmark, "cyber");
	assert.equal(sidecar.challengeCount, 2);
	assert.deepEqual(sidecar.models.map((m: { model: string; solved: number }) => [m.model, m.solved]), [["alpha", 2], ["beta", 1]]);
	assert.ok(readFileSync(out.htmlPath, "utf8").includes("2/2 · 100%"));
});

test("a model with no results rejects naming it and writes nothing", async () => {
	const f = await fixture();
	await assert.rejects(generateReport({ benchmark: "cyber", models: ["alpha", "ghost"], ...f }), /ghost/);
	assert.equal(existsSync(f.reportsDir) ? readdirSync(f.reportsDir).length : 0, 0);
});

test("a failing narrator still yields a report, without narrative", async () => {
	const f = await fixture();
	const out = await generateReport({
		benchmark: "cyber",
		models: ["alpha"],
		...f,
		narrate: async () => {
			throw new Error("llm down");
		},
	});
	assert.equal(JSON.parse(readFileSync(out.jsonPath, "utf8")).narrative, null);
});

test("the narrative is included when the narrator returns one", async () => {
	const f = await fixture();
	const out = await generateReport({ benchmark: "cyber", models: ["alpha"], ...f, narrate: async () => "Alpha cruised." });
	assert.ok(readFileSync(out.htmlPath, "utf8").includes("Alpha cruised."));
});
