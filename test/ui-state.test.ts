import assert from "node:assert/strict";
import test from "node:test";
import { canStart, createState, groupModels, groupRuns, removeStaged, selectModel, stageRun } from "../src/ui/state.js";

const m = (name: string, over: Record<string, unknown> = {}) => ({ name, modelId: name, session: false, needsKey: false, benchmarked: [] as string[], ...over });
const benches = [
	{ name: "cyber", challenges: ["locktalk", "chunky"], needsPrompt: false },
	{ name: "minimal", challenges: [], needsPrompt: true },
];
const ready = (models = [m("a")]) => selectModel({ ...createState(), models, benchmarks: benches }, "a");

test("canStart lists exactly the missing fields", () => {
	assert.deepEqual(canStart(createState()), { ok: false, missing: ["model"] });
	assert.deepEqual(canStart(ready()), { ok: true, missing: [] });

	const keyed = ready([m("a", { needsKey: true })]);
	assert.deepEqual(canStart(keyed).missing, ["API key"]);
	assert.equal(canStart({ ...keyed, form: { ...keyed.form, apiKey: "k" } }).ok, true);

	const minimal = { ...ready(), form: { ...ready().form, benchmark: "minimal" } };
	assert.deepEqual(canStart(minimal).missing, ["prompt"]);
	assert.equal(canStart({ ...minimal, form: { ...minimal.form, prompt: "say hi" } }).ok, true);

	const none = { ...ready(), form: { ...ready().form, challenges: [] as string[] } };
	assert.deepEqual(canStart(none).missing, ["challenges"]);
});

test("a read-only model cannot be started", () => {
	const s = ready([m("a", { readOnly: true, needsKey: true })]);
	assert.ok(canStart(s).missing.some((x: string) => x.startsWith("model")));
});

test("selecting a model clears any key typed for the previous one", () => {
	let s = ready([m("a"), m("b")]);
	s = { ...s, form: { ...s.form, apiKey: "secret" } };
	assert.equal(selectModel(s, "b").form.apiKey, "");
});

test("staging copies the form into the queue and removing empties it again", () => {
	let s = ready();
	s = stageRun(s);
	assert.equal(s.queue.length, 1);
	assert.deepEqual(s.queue[0], { model: "a", benchmark: "cyber", challenges: "all", prompt: "", apiKey: "" });
	s = removeStaged(s, 0);
	assert.deepEqual(s.queue, []);
});

test("two staged items for one model on different benchmarks stay separate", () => {
	let s = stageRun(ready());
	s = stageRun({ ...s, form: { ...s.form, benchmark: "minimal", prompt: "hi" } });
	assert.deepEqual(s.queue.map((q: { benchmark: string }) => q.benchmark), ["cyber", "minimal"]);
});

test("groupModels puts a never-run model under Not benchmarked and a twice-run model in both groups", () => {
	const groups = groupModels([m("fresh"), m("both", { benchmarked: ["cyber", "minimal"] }), m("c", { benchmarked: ["cyber"] })]);
	assert.deepEqual(groups.map((g: { domain: string }) => g.domain), ["cyber", "minimal", "Not benchmarked"]);
	assert.deepEqual(groups[0].models.map((x: { name: string }) => x.name), ["both", "c"]);
	assert.deepEqual(groups[1].models.map((x: { name: string }) => x.name), ["both"]);
	assert.deepEqual(groups[2].models.map((x: { name: string }) => x.name), ["fresh"]);
});

const job = (id: string, status: string, runId: string | undefined, over: Record<string, unknown> = {}) => ({
	id, status, model: "a", benchmark: "cyber", createdAt: "2026-11-09T00:00:00Z", params: runId ? { runId, challenge: id } : undefined, ...over,
});

test("groupRuns reports running while any job is unfinished", () => {
	const [run] = groupRuns([job("1", "done", "r"), job("2", "running", "r"), job("3", "queued", "r")]);
	assert.equal(run.status, "running");
	assert.equal(run.total, 3);
	assert.equal(run.finished, 1);
});

test("groupRuns reports error, cancelled and done once everything settled", () => {
	assert.equal(groupRuns([job("1", "done", "r"), job("2", "error", "r")])[0].status, "error");
	assert.equal(groupRuns([job("1", "cancelled", "r"), job("2", "cancelled", "r")])[0].status, "cancelled");
	assert.equal(groupRuns([job("1", "done", "r"), job("2", "done", "r")])[0].status, "done");
});

test("groupRuns ignores jobs without a runId and rebuilds a run from the jobs alone", () => {
	const runs = groupRuns([job("x", "done", undefined), job("1", "done", "r1"), job("2", "done", "r2")]);
	assert.deepEqual(runs.map((r: { runId: string }) => r.runId), ["r1", "r2"]);
	assert.equal(runs[0].model, "a");
	assert.equal(runs[0].benchmark, "cyber");
});
