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

import { toModelPayload, validateNewModel } from "../src/ui/state.js";

const form = (over: Record<string, string> = {}) => ({ name: "m", modelId: "", baseUrl: "https://x/v1", api: "openai-completions", apiKey: "k", thinkingLevel: "off", costIn: "", costOut: "", ...over });

test("validateNewModel lists every missing required field", () => {
	const { ok, errors } = validateNewModel({ name: "", modelId: "", baseUrl: "", api: "", apiKey: "", thinkingLevel: "off", costIn: "", costOut: "" });
	assert.equal(ok, false);
	assert.deepEqual(Object.keys(errors).sort(), ["api", "apiKey", "baseUrl", "name"]);
});

test("validateNewModel rejects a base URL that is not http or https and accepts a valid form", () => {
	assert.ok(validateNewModel(form({ baseUrl: "ftp://x" })).errors.baseUrl);
	assert.deepEqual(validateNewModel(form()), { ok: true, errors: {} });
});

test("validateNewModel rejects prices that are not non-negative numbers", () => {
	assert.ok(validateNewModel(form({ costIn: "-1", costOut: "2" })).errors.cost);
	assert.ok(validateNewModel(form({ costIn: "1" })).errors.cost);
	assert.equal(validateNewModel(form({ costIn: "0.1", costOut: "0.4" })).ok, true);
});

test("toModelPayload defaults modelId to the name and only sends a price when both are set", () => {
	assert.deepEqual(toModelPayload(form()), { name: "m", modelId: "m", baseUrl: "https://x/v1", api: "openai-completions", apiKey: "k", thinkingLevel: "off" });
	assert.deepEqual(toModelPayload(form({ modelId: "m-1", costIn: "0.1", costOut: "0.4" })).cost, { input: 0.1, output: 0.4 });
});

import { againForm, formatElapsed } from "../src/ui/state.js";

test("formatElapsed shows minutes and seconds", () => {
	assert.equal(formatElapsed(0), "00:00");
	assert.equal(formatElapsed(65_000), "01:05");
	assert.equal(formatElapsed(3_725_000), "62:05");
	assert.equal(formatElapsed(-5), "00:00");
});

test("againForm reopens the same benchmark with the same challenges or prompt", () => {
	const cyber = { runId: "r", model: "a", benchmark: "cyber", jobs: [job("1", "done", "r"), job("2", "done", "r")] };
	assert.deepEqual(againForm(cyber, [{ name: "cyber", challenges: ["1", "2"], needsPrompt: false }]), { benchmark: "cyber", challenges: "all", prompt: "" });
	assert.deepEqual(againForm({ ...cyber, jobs: [job("1", "done", "r")] }, [{ name: "cyber", challenges: ["1", "2"], needsPrompt: false }]), { benchmark: "cyber", challenges: ["1"], prompt: "" });
	const minimal = { runId: "r", model: "a", benchmark: "minimal", jobs: [{ ...job("x", "done", "r"), prompt: "say hi" }] };
	assert.deepEqual(againForm(minimal, [{ name: "minimal", challenges: [], needsPrompt: true }]), { benchmark: "minimal", challenges: "all", prompt: "say hi" });
});
