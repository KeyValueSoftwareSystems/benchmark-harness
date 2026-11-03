import assert from "node:assert/strict";
import test from "node:test";
import { computeMetrics } from "../src/reports/metrics.ts";
import type { ModelFile, RunRecord } from "../src/shared/results.ts";

const run = (jobId: string, correct: boolean | null, durationMs: number, costUsd: number): RunRecord => ({
	jobId,
	benchmark: "cyber",
	model: "gpt-x",
	modelId: "m",
	challenge: jobId,
	status: "done",
	correct,
	outcome: null,
	metrics: { turns: 1, durationMs, inputTokens: 0, outputTokens: 0, costUsd },
	sessionId: null,
	traceIds: null,
	netraMetadata: null,
	conditions: {},
	createdAt: "x",
	finishedAt: "y",
});
const file = (runs: RunRecord[]): ModelFile => ({ benchmark: "cyber", model: "gpt-x", modelId: "m", runs });

test("computes solved, rate, median solve time over solved runs and average cost", () => {
	const m = computeMetrics(file([run("a", true, 180_000, 0.3), run("b", true, 300_000, 0.2), run("c", false, 900_000, 0.1)]));
	assert.equal(m.solved, 2);
	assert.equal(m.total, 3);
	assert.equal(m.successRate, 66.7);
	assert.equal(m.medianSolveMs, 240_000);
	assert.equal(m.avgCostUsd, 0.2);
});

test("an empty file gives rate 0 and null median and cost", () => {
	const m = computeMetrics(file([]));
	assert.deepEqual([m.solved, m.total, m.successRate, m.medianSolveMs, m.avgCostUsd], [0, 0, 0, null, null]);
});

test("runs without a verdict count in the total but not as solved", () => {
	const m = computeMetrics(file([run("a", null, 1000, 0), run("b", true, 2000, 0)]));
	assert.deepEqual([m.solved, m.total, m.medianSolveMs], [1, 2, 2000]);
});
