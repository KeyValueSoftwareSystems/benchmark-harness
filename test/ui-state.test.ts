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

import { runItems, settledSince } from "../src/ui/state.js";

test("runItems starts items one by one and reports each as it starts", async () => {
	const seen: string[] = [];
	const out = await runItems(["a", "b"], async (x: string) => `run-${x}`, (item: string, id: string) => seen.push(`${item}:${id}`));
	assert.deepEqual(out, { started: ["run-a", "run-b"], failed: null, error: null });
	assert.deepEqual(seen, ["a:run-a", "b:run-b"]);
});

test("runItems stops at the first failure and says what already started and what failed", async () => {
	const seen: string[] = [];
	const boom = new Error("model refused");
	const out = await runItems(["a", "b", "c"], async (x: string) => { if (x === "b") throw boom; return `run-${x}`; }, (item: string) => seen.push(item));
	assert.deepEqual(out.started, ["run-a"]);
	assert.equal(out.failed, "b");
	assert.equal(out.error, boom);
	assert.deepEqual(seen, ["a"]);
});

test("settledSince is true only when a run that was running has now settled", () => {
	const runs = (status: string) => [{ runId: "r1", status }];
	assert.equal(settledSince(new Map([["r1", "running"]]), runs("done")), true);
	assert.equal(settledSince(new Map([["r1", "running"]]), runs("running")), false);
	assert.equal(settledSince(new Map([["r1", "done"]]), runs("done")), false);
	assert.equal(settledSince(new Map(), runs("done")), false);
});

import { challengeSummary, filterChallenges, toggleChallenge } from "../src/ui/state.js";

const ALL = ["locktalk", "chunky", "ezmaze"];

test("challengeSummary reads naturally for all, some and none", () => {
	assert.equal(challengeSummary("all", 43), "All (43)");
	assert.equal(challengeSummary(["a", "b"], 43), "2 of 43 selected");
	assert.equal(challengeSummary([], 43), "None selected");
	assert.equal(challengeSummary(["a"], 1), "All (1)");
});

test("toggleChallenge unticks one from all, ticks more, and goes back to all when everything is ticked", () => {
	assert.deepEqual(toggleChallenge("all", "chunky", ALL), ["locktalk", "ezmaze"]);
	assert.deepEqual(toggleChallenge(["locktalk"], "ezmaze", ALL), ["locktalk", "ezmaze"]);
	assert.deepEqual(toggleChallenge(["locktalk", "ezmaze"], "locktalk", ALL), ["ezmaze"]);
	assert.equal(toggleChallenge(["locktalk", "ezmaze"], "chunky", ALL), "all");
});

test("filterChallenges matches any part of the name, ignoring case", () => {
	assert.deepEqual(filterChallenges(ALL, "LOCK"), ["locktalk"]);
	assert.deepEqual(filterChallenges(ALL, "z"), ["ezmaze"]);
	assert.deepEqual(filterChallenges(ALL, ""), ALL);
	assert.deepEqual(filterChallenges(ALL, "nope"), []);
});

import { stageCheck } from "../src/ui/state.js";

const withForm = (s: ReturnType<typeof ready>, patch: Record<string, unknown>) => ({ ...s, form: { ...s.form, ...patch } });

test("a model with the same benchmark, challenges and prompt is a duplicate in the queue", () => {
	const s = stageRun(ready());
	assert.deepEqual(stageCheck(s), { ok: false, message: "Model configuration already in queue" });
});

test("the same model with different parameters is allowed", () => {
	const s = stageRun(ready());
	assert.equal(stageCheck(withForm(s, { challenges: ["locktalk"] })).ok, true);
	assert.equal(stageCheck(withForm(s, { benchmark: "minimal", prompt: "hi" })).ok, true);
});

test("challenge order does not make a configuration different, and the key never counts", () => {
	let s = ready();
	s = stageRun(withForm(s, { challenges: ["locktalk", "chunky"], apiKey: "one" }));
	assert.equal(stageCheck(withForm(s, { challenges: ["chunky", "locktalk"], apiKey: "two" })).ok, false);
});

test("prompts that differ only by surrounding spaces are the same configuration", () => {
	let s = withForm(ready(), { benchmark: "minimal", prompt: "say hi" });
	s = stageRun(s);
	assert.equal(stageCheck(withForm(s, { prompt: "  say hi  " })).ok, false);
	assert.equal(stageCheck(withForm(s, { prompt: "say bye" })).ok, true);
});

test("the queue holds at most the API's limit, 5 unless it says otherwise", () => {
	assert.equal(createState().queueLimit, 5);
	let s = { ...ready(), queueLimit: 2 };
	s = stageRun(withForm(s, { benchmark: "minimal", prompt: "a" }));
	s = stageRun(withForm(s, { benchmark: "minimal", prompt: "b" }));
	assert.deepEqual(stageCheck(withForm(s, { benchmark: "minimal", prompt: "c" })), { ok: false, message: "Queue is full (2 items). Start some first." });
});

test("a duplicate is reported before the queue is reported full", () => {
	let s = { ...ready(), queueLimit: 1 };
	s = stageRun(s);
	assert.equal(stageCheck(s).message, "Model configuration already in queue");
});

import { describeQueueItem } from "../src/ui/state.js";

const benchList = [
	{ name: "cyber", challenges: ["locktalk", "chunky", "ezmaze"], needsPrompt: false },
	{ name: "minimal", challenges: [], needsPrompt: true },
];

test("describeQueueItem lists exactly what a queued cyber run will do", () => {
	assert.deepEqual(describeQueueItem({ model: "a", benchmark: "cyber", challenges: "all", prompt: "", apiKey: "secret" }, benchList), [
		["Model", "a"],
		["Benchmark", "cyber"],
		["Challenges", "All (3): locktalk, chunky, ezmaze"],
	]);
	assert.deepEqual(describeQueueItem({ model: "a", benchmark: "cyber", challenges: ["chunky"], prompt: "", apiKey: "" }, benchList).at(-1), ["Challenges", "1 of 3: chunky"]);
});

test("describeQueueItem shows the prompt for a prompt benchmark and never the key", () => {
	const rows = describeQueueItem({ model: "a", benchmark: "minimal", challenges: "all", prompt: "say hi", apiKey: "sk-secret" }, benchList);
	assert.deepEqual(rows, [["Model", "a"], ["Benchmark", "minimal"], ["Prompt", "say hi"]]);
	assert.ok(!JSON.stringify(rows).includes("sk-secret"));
});

import { summarizeError } from "../src/ui/state.js";

test("summarizeError keeps a short message as it is", () => {
	assert.equal(summarizeError("model refused"), "model refused");
});

test("summarizeError keeps only the first line of a multi-line docker error", () => {
	const long = `Error: Command failed: docker compose -p job-1 -f /x/compose.yml up -d --build --wait\n${"Container job-1-x Waiting ".repeat(30)}\ncontainer is unhealthy`;
	assert.equal(summarizeError(long), "Error: Command failed: docker compose -p job-1 -f /x/compose.yml up -d --build --wait");
});

test("summarizeError cuts a very long single line and marks the cut", () => {
	const out = summarizeError(`Error: ${"x".repeat(500)}`);
	assert.equal(out.length, 141);
	assert.ok(out.endsWith("…"));
});
