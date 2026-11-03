import assert from "node:assert/strict";
import test from "node:test";
import { renderReport } from "../src/reports/render.ts";

const input = {
	title: "CTF Benchmark Results",
	benchmark: "cyber",
	challengeCount: 40,
	conditions: "Same tools and time limit · One attempt per challenge",
	models: [
		{ model: "Agent B", solved: 26, total: 40, successRate: 65, medianSolveMs: 300_000, avgCostUsd: 0.2 },
		{ model: "Agent A", solved: 32, total: 40, successRate: 80, medianSolveMs: 180_000, avgCostUsd: 0.3 },
	],
};

test("renders the title card, bars, footnote and metrics table", () => {
	const html = renderReport(input);
	assert.ok(html.startsWith("<!doctype html>"));
	assert.ok(html.includes("CTF Benchmark Results"));
	assert.ok(html.includes("40 challenges"));
	assert.ok(html.includes("32/40 · 80%"));
	assert.ok(html.includes("26/40 · 65%"));
	assert.ok(html.includes("Primary metric: successful challenges ÷ total valid challenges × 100."));
	assert.ok(html.includes("3 min") && html.includes("5 min"));
	assert.ok(html.includes("$0.30") && html.includes("$0.20"));
	assert.equal(html.split("To measure").length - 1, 2);
});

test("orders bars by success rate, best first", () => {
	const html = renderReport(input);
	assert.ok(html.indexOf("Agent A") < html.indexOf("Agent B"));
});

test("escapes model names and the narrative", () => {
	const html = renderReport({ ...input, models: [{ ...input.models[0], model: "<script>x</script>" }], narrative: "<img src=x onerror=1>" });
	assert.ok(!html.includes("<script>x"));
	assert.ok(!html.includes("<img src=x"));
	assert.ok(html.includes("&lt;script&gt;"));
});

test("zero total challenges renders without NaN", () => {
	const html = renderReport({ ...input, models: [{ model: "m", solved: 0, total: 0, successRate: 0, medianSolveMs: null, avgCostUsd: null }] });
	assert.ok(!html.includes("NaN"));
	assert.ok(html.includes("0/0 · 0%"));
});

test("a model that attempted fewer challenges than the benchmark has is flagged partial", () => {
	const html = renderReport({ ...input, models: [{ model: "Short", solved: 8, total: 10, successRate: 80, medianSolveMs: 1000, avgCostUsd: 0.1 }] });
	assert.ok(html.includes("8/10 · 80% (partial)"));
	assert.ok(!renderReport(input).includes("(partial)"));
});
