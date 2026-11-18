import assert from "node:assert/strict";
import test from "node:test";
import { benchmarkNames, createState, filterModels, modelStatus, newestFirst, readiness, runStats, selectModel, solveCurve, sortByResult } from "../src/ui/state.js";

const m = (name: string, over: Record<string, unknown> = {}) => ({ name, modelId: name, session: false, needsKey: false, benchmarked: [] as string[], ...over });
const benches = [
	{ name: "cyber", challenges: ["a", "b", "c"], needsPrompt: false },
	{ name: "minimal", challenges: [], needsPrompt: true },
];
const job = (id: string, runId: string, status: string, createdAt: string, challenge?: string) => ({ id, model: "x", benchmark: "cyber", status, createdAt, params: { runId, ...(challenge ? { challenge } : {}) } });

test("benchmarkNames lists each benchmark a model has run on once, sorted", () => {
	assert.deepEqual(benchmarkNames([m("a", { benchmarked: ["cyber", "minimal"] }), m("b", { benchmarked: ["cyber"] }), m("c")]), ["cyber", "minimal"]);
});

test("filterModels keeps all, one benchmark, or the never-benchmarked", () => {
	const list = [m("a", { benchmarked: ["cyber"] }), m("b", { benchmarked: ["minimal"] }), m("c")];
	assert.deepEqual(filterModels(list, "all").map((x: { name: string }) => x.name), ["a", "b", "c"]);
	assert.deepEqual(filterModels(list, "cyber").map((x: { name: string }) => x.name), ["a"]);
	assert.deepEqual(filterModels(list, "none").map((x: { name: string }) => x.name), ["c"]);
});

test("modelStatus names read-only before needs-key, then session, then ready", () => {
	assert.deepEqual(modelStatus(m("a", { readOnly: true, needsKey: true })), { label: "Read-only", tone: "mute" });
	assert.deepEqual(modelStatus(m("a", { needsKey: true })), { label: "Needs key", tone: "warn" });
	assert.deepEqual(modelStatus(m("a", { session: true })), { label: "Session", tone: "mute" });
	assert.deepEqual(modelStatus(m("a")), { label: "Ready", tone: "ok" });
});

test("readiness lists each check the run needs and whether it is done", () => {
	const base = selectModel({ ...createState(), models: [m("a")], benchmarks: benches }, "a");
	assert.deepEqual(readiness(base), [
		{ label: "Model selected", done: true },
		{ label: "Benchmark chosen", done: true },
		{ label: "3 challenges selected", done: true },
	]);
	const none = { ...base, form: { ...base.form, challenges: [] as string[] } };
	assert.deepEqual(readiness(none)[2], { label: "0 challenges selected", done: false });
	const prompt = { ...base, form: { ...base.form, benchmark: "minimal" } };
	assert.deepEqual(readiness(prompt)[2], { label: "Prompt written", done: false });
	const keyed = selectModel({ ...base, models: [m("a", { needsKey: true })] }, "a");
	assert.deepEqual(readiness(keyed).at(-1), { label: "API key entered", done: false });
	assert.deepEqual(readiness(createState()), [{ label: "Model selected", done: false }]);
});

test("newestFirst orders runs by when their first job was created", () => {
	const runs = [
		{ runId: "old", jobs: [job("1", "old", "done", "2026-01-01T00:00:00Z")] },
		{ runId: "new", jobs: [job("2", "new", "done", "2026-03-01T00:00:00Z")] },
	];
	assert.deepEqual(newestFirst(runs).map((r) => r.runId), ["new", "old"]);
});

test("runStats counts solved, finished and failed jobs from the verdicts", () => {
	const run = { jobs: [job("1", "r", "done", ""), job("2", "r", "done", ""), job("3", "r", "error", ""), job("4", "r", "running", "")] };
	const correct = new Map<string, boolean | null>([["1", true], ["2", false]]);
	assert.deepEqual(runStats(run, correct), { total: 4, finished: 3, solved: 1, errors: 1 });
});

test("solveCurve is the running solved count after each finished job, starting at zero", () => {
	const run = { jobs: [job("1", "r", "done", ""), job("2", "r", "done", ""), job("3", "r", "done", ""), job("4", "r", "queued", "")] };
	const correct = new Map<string, boolean | null>([["1", true], ["2", false], ["3", true]]);
	assert.deepEqual(solveCurve(run, correct), [0, 1, 1, 2]);
});

test("sortByResult orders by score, unknown scores last either way", () => {
	const score = new Map([["a", 0.2], ["b", 0.9]]);
	const list = [m("a"), m("c"), m("b")];
	assert.deepEqual(sortByResult(list, (x: { name: string }) => score.get(x.name), "desc").map((x) => x.name), ["b", "a", "c"]);
	assert.deepEqual(sortByResult(list, (x: { name: string }) => score.get(x.name), "asc").map((x) => x.name), ["a", "b", "c"]);
});
