// Pure page state: no DOM, no network. Every function returns a new state instead of changing the old one.

export const createState = () => ({
	models: [],
	benchmarks: [],
	selected: null,
	form: { benchmark: "cyber", challenges: "all", prompt: "", apiKey: "" },
	queue: [],
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
