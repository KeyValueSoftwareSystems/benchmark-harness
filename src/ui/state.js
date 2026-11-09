// Pure page state: no DOM, no network. Every function returns a new state instead of changing the old one.

export const createState = () => ({
	models: [],
	benchmarks: [],
	selected: null,
	form: { benchmark: "cyber", challenges: "all", prompt: "", apiKey: "" },
	queue: [],
	queueLimit: 5,
});

const selectedModel = (s) => s.models.find((m) => m.name === s.selected);
const selectedBenchmark = (s) => s.benchmarks.find((b) => b.name === s.form.benchmark);

/** A different model starts with an empty key field: a key typed for one model is never carried to another. */
export const selectModel = (s, name) => ({ ...s, selected: name, form: { ...s.form, apiKey: "" } });

/** Whether the current form can run, and the visible names of what is still missing. */
export function canStart(s) {
	const model = selectedModel(s);
	if (!model) return { ok: false, missing: ["model"] };
	if (model.readOnly) return { ok: false, missing: ["model (add it again to re-run)"] };
	const missing = [];
	if (model.needsKey && !s.form.apiKey) missing.push("API key");
	const bench = selectedBenchmark(s);
	if (!bench) missing.push("benchmark");
	else if (bench.needsPrompt && !s.form.prompt.trim()) missing.push("prompt");
	if (Array.isArray(s.form.challenges) && s.form.challenges.length === 0) missing.push("challenges");
	return { ok: missing.length === 0, missing };
}

/** Copies the current form into the queue. The key stays in memory only and is handed to the API when the run starts. */
export const stageRun = (s) => ({
	...s,
	queue: [...s.queue, { model: s.selected, benchmark: s.form.benchmark, challenges: s.form.challenges, prompt: s.form.prompt, apiKey: s.form.apiKey }],
});
export const removeStaged = (s, index) => ({ ...s, queue: s.queue.filter((_, i) => i !== index) });

/** Groups by benchmark; a model that ran on two benchmarks is in both, one never run is under "Not benchmarked". */
export function groupModels(models) {
	const groups = new Map();
	const fresh = [];
	for (const m of models) {
		if (!m.benchmarked.length) fresh.push(m);
		for (const b of m.benchmarked) groups.set(b, [...(groups.get(b) ?? []), m]);
	}
	const out = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([domain, list]) => ({ domain, models: list }));
	if (fresh.length) out.push({ domain: "Not benchmarked", models: fresh });
	return out;
}

const SETTLED = new Set(["done", "error", "cancelled"]);

/** One entry per run (jobs that share `params.runId`), rebuilt from the job list alone, so a reload loses nothing. */
export function groupRuns(jobs) {
	const byRun = new Map();
	for (const j of jobs) {
		const id = j.params?.runId;
		if (id) byRun.set(id, [...(byRun.get(id) ?? []), j]);
	}
	return [...byRun].map(([runId, list]) => {
		const finished = list.filter((j) => SETTLED.has(j.status)).length;
		const status =
			finished < list.length ? "running" : list.every((j) => j.status === "cancelled") ? "cancelled" : list.some((j) => j.status === "error") ? "error" : "done";
		return { runId, model: list[0].model, benchmark: list[0].benchmark, jobs: list, total: list.length, finished, status };
	});
}

const isHttp = (u) => /^https?:\/\/\S+$/.test(u);
const isPrice = (v) => v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0;

/** The Add-a-model card's checks; `errors` is keyed by field so each message sits beside its field. */
export function validateNewModel(f) {
	const errors = {};
	if (!f.name.trim()) errors.name = "Enter the model name.";
	if (!f.baseUrl.trim()) errors.baseUrl = "Enter the base URL.";
	else if (!isHttp(f.baseUrl.trim())) errors.baseUrl = "The base URL must start with http:// or https://.";
	if (!f.api.trim()) errors.api = "Choose the API type.";
	if (!f.apiKey) errors.apiKey = "Enter the API key. It is kept in memory only.";
	if ((f.costIn !== "" || f.costOut !== "") && !(isPrice(f.costIn) && isPrice(f.costOut))) errors.cost = "Enter both prices as numbers, or leave both empty.";
	return { ok: Object.keys(errors).length === 0, errors };
}

/** The body of `POST /models` from a valid card. */
export const toModelPayload = (f) => ({
	name: f.name.trim(),
	modelId: f.modelId.trim() || f.name.trim(),
	baseUrl: f.baseUrl.trim(),
	api: f.api.trim(),
	apiKey: f.apiKey,
	thinkingLevel: f.thinkingLevel || undefined,
	...(f.costIn !== "" && f.costOut !== "" ? { cost: { input: Number(f.costIn), output: Number(f.costOut) } } : {}),
});

/** mm:ss for a duration in milliseconds. */
export const formatElapsed = (ms) => {
	const total = Math.max(0, Math.floor(ms / 1000));
	return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** The benchmark form values that repeat a finished run: same benchmark, same challenges (or prompt). */
export function againForm(run, benchmarks) {
	const bench = benchmarks.find((b) => b.name === run.benchmark);
	if (bench?.needsPrompt) return { benchmark: run.benchmark, challenges: "all", prompt: run.jobs[0]?.prompt ?? "" };
	const ids = run.jobs.map((j) => j.params?.challenge).filter(Boolean);
	const every = bench && ids.length === bench.challenges.length && bench.challenges.every((c) => ids.includes(c));
	return { benchmark: run.benchmark, challenges: every || !ids.length ? "all" : ids, prompt: "" };
}

/** Runs items one at a time, reporting each as it starts, and stops at the first failure so nothing starts twice. */
export async function runItems(items, startOne, onStarted = (_item, _id) => {}) {
	const started = [];
	for (const item of items) {
		try {
			const id = await startOne(item);
			started.push(id);
			onStarted(item, id);
		} catch (error) {
			return { started, failed: item, error };
		}
	}
	return { started, failed: null, error: null };
}

/** True when a run that was running at the last look has settled since. */
export const settledSince = (previous, runs) => runs.some((r) => previous.get(r.runId) === "running" && r.status !== "running");

/** The text on the challenge picker button. */
export const challengeSummary = (value, total) => (value === "all" || value.length === total ? `All (${total})` : value.length === 0 ? "None selected" : `${value.length} of ${total} selected`);

/** Ticks or unticks one challenge; ticking the last missing one returns to "all". */
export function toggleChallenge(value, id, all) {
	const current = value === "all" ? all : value;
	const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
	return next.length === all.length ? "all" : next;
}

export const filterChallenges = (list, query) => list.filter((c) => c.toLowerCase().includes(query.trim().toLowerCase()));

const sameConfig = (a, b) => {
	const ids = (c) => (c === "all" ? "all" : [...c].sort().join("\u0000"));
	return a.model === b.model && a.benchmark === b.benchmark && ids(a.challenges) === ids(b.challenges) && a.prompt.trim() === b.prompt.trim();
};

/** Whether the current form may join the queue: not a repeat of something queued, and the queue is not full. */
export function stageCheck(s) {
	const item = { model: s.selected, benchmark: s.form.benchmark, challenges: s.form.challenges, prompt: s.form.prompt };
	if (s.queue.some((q) => sameConfig(q, item))) return { ok: false, message: "Model configuration already in queue" };
	if (s.queue.length >= s.queueLimit) return { ok: false, message: `Queue is full (${s.queueLimit} items). Start some first.` };
	return { ok: true };
}

/** The exact settings of a queued item as label/value rows. The API key is never part of it. */
export function describeQueueItem(item, benchmarks) {
	const bench = benchmarks.find((b) => b.name === item.benchmark);
	const rows = [["Model", item.model], ["Benchmark", item.benchmark]];
	if (bench?.needsPrompt) rows.push(["Prompt", item.prompt]);
	else {
		const all = bench?.challenges ?? [];
		rows.push(["Challenges", item.challenges === "all" ? `All (${all.length}): ${all.join(", ")}` : `${item.challenges.length} of ${all.length}: ${item.challenges.join(", ")}`]);
	}
	return rows;
}

const MAX_ERROR = 140;
/** One short line for a failed job; the full text stays available behind a Details control. */
export function summarizeError(text) {
	const line = String(text).split("\n")[0].replace(/\s+/g, " ").trim();
	return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR)}…` : line;
}
