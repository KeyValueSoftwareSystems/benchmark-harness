import assert from "node:assert/strict";
import test from "node:test";
import { summarizeNetra } from "../src/reports/netra.ts";
import type { ModelFile, RunRecord } from "../src/shared/results.ts";

const trace = (over: Record<string, unknown> = {}) => ({
	id: "t",
	latency_ms: 1000,
	prompt_tokens: "100",
	completion_tokens: "10",
	has_error: false,
	...over,
});
const run = (jobId: string, traces: unknown[] | null, over: Partial<RunRecord> = {}): RunRecord => ({
	jobId,
	benchmark: "cyber",
	model: "m",
	modelId: "m",
	challenge: jobId,
	assistant: null,
	status: "done",
	correct: true,
	outcome: null,
	metrics: { turns: 1, durationMs: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 },
	sessionId: "s",
	traceIds: null,
	netraMetadata: traces ? { session: {}, traces } : null,
	conditions: {},
	createdAt: "x",
	finishedAt: "y",
	...over,
});
const file = (runs: RunRecord[]): ModelFile => ({ benchmark: "cyber", model: "m", modelId: "m", runs });

test("averages latency and tokens across traces and counts traces with errors", () => {
	const s = summarizeNetra(
		file([
			run("a", [trace()]),
			run("b", [trace({ latency_ms: 3000, prompt_tokens: "300", completion_tokens: "30", has_error: true })]),
		]),
	);
	assert.deepEqual(s, { model: "m", traces: 2, avgLatencyMs: 2000, avgInputTokens: 200, avgOutputTokens: 20, errorTraces: 1 });
});

test("a model whose runs have no Netra data has no summary", () => {
	assert.equal(summarizeNetra(file([run("a", null)])), null);
	assert.equal(summarizeNetra(file([run("a", [])])), null);
});

test("traces missing a field are left out of that average, not counted as zero", () => {
	const s = summarizeNetra(file([run("a", [trace(), trace({ latency_ms: undefined, prompt_tokens: undefined })])]));
	assert.equal(s?.traces, 2);
	assert.equal(s?.avgLatencyMs, 1000);
	assert.equal(s?.avgInputTokens, 100);
});

test("re-runs of a challenge count once, like the benchmark numbers", () => {
	const s = summarizeNetra(
		file([
			run("old", [trace({ latency_ms: 9000 })], { challenge: "c1", createdAt: "2026-11-01" }),
			run("new", [trace({ latency_ms: 1000 })], { challenge: "c1", createdAt: "2026-11-02" }),
		]),
	);
	assert.equal(s?.traces, 1);
	assert.equal(s?.avgLatencyMs, 1000);
});
