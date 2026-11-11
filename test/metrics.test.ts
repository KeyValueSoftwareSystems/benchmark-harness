import assert from "node:assert/strict";
import test from "node:test";
import { computeMetrics } from "../src/reports/metrics.ts";
import type { ModelFile, RunRecord } from "../src/shared/results.ts";

const run = (jobId: string, correct: boolean | null, durationMs: number, costUsd: number, over: Partial<RunRecord> = {}): RunRecord => ({
	jobId,
	benchmark: "cyber",
	model: "gpt-x",
	modelId: "m",
	challenge: jobId,
	assistant: null,
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
	...over,
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

test("repeated runs of one challenge count once: the latest wins", () => {
	const m = computeMetrics(
		file([
			run("old", false, 1000, 0.1, { challenge: "c1", createdAt: "2026-11-01T00:00:00Z" }),
			run("new", true, 2000, 0.1, { challenge: "c1", createdAt: "2026-11-02T00:00:00Z" }),
			run("other", true, 2000, 0.1, { challenge: "c2", createdAt: "2026-11-01T00:00:00Z" }),
		]),
	);
	assert.deepEqual([m.solved, m.total, m.successRate], [2, 2, 100]);
});

test("runs without a challenge are each their own attempt", () => {
	const m = computeMetrics(file([run("a", true, 1, 0, { challenge: null }), run("b", false, 1, 0, { challenge: null })]));
	assert.deepEqual([m.solved, m.total], [1, 2]);
});

test("a run that never reported (zero turns) does not drag the average cost down", () => {
	const reported = run("a", true, 1000, 0.4);
	const lost = run("b", false, 0, 0, { status: "error", metrics: { turns: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } });
	const m = computeMetrics(file([reported, lost]));
	assert.equal(m.total, 2);
	assert.equal(m.avgCostUsd, 0.4);
});
