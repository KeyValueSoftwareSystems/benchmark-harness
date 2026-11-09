import { api } from "../api.js";
import { clear, h } from "../dom.js";
import { formatElapsed, groupRuns, settledSince, summarizeError } from "../state.js";

let timer = null;
let generation = 0; // a poll that finishes after the view changed must not paint
const solved = new Map(); // jobId -> true | false | null, filled once a run has settled
const reports = new Map(); // runId -> { url } | { error }
let previous = new Map(); // runId -> status at the last poll

const stopTimer = () => {
	clearInterval(timer);
	timer = null;
};
export const stopRunning = () => {
	generation++;
	stopTimer();
};

const STATUS = { queued: "waiting", provisioning: "starting", running: "running", done: "finished", error: "failed", cancelled: "cancelled" };

function errorLine(text) {
	const short = summarizeError(text);
	const more = text !== short;
	return h("div", { class: "error err" }, short, more ? h("details", {}, h("summary", {}, "Details"), h("pre", {}, text)) : null);
}

function jobLine(job, run) {
	const label = job.params?.challenge ?? "prompt";
	const verdict = job.status === "done" && solved.has(job.id) ? (solved.get(job.id) === true ? " · solved" : solved.get(job.id) === false ? " · not solved" : "") : "";
	const elapsed = job.status === "running" || job.status === "provisioning" ? ` · ${formatElapsed(Date.now() - Date.parse(job.createdAt))}` : "";
	return h("li", { class: `jl ${job.status}` }, h("span", { "aria-hidden": "true" }, job.status === "done" ? "✓" : job.status === "error" ? "✕" : job.status === "cancelled" ? "–" : "○"), " ", h("strong", {}, label), ` ${STATUS[job.status] ?? job.status}${verdict}${elapsed}`, job.error ? errorLine(job.error) : null);
}

function runCard(ctx, run, redraw) {
	const running = run.status === "running";
	const report = reports.get(run.runId);
	return h("div", { class: "card run" },
		h("div", { class: "run-h" },
			running ? h("span", { class: "gear", "aria-hidden": "true" }, "⚙") : null,
			h("div", {}, h("h3", {}, run.model), h("p", { class: "hint" }, `${run.benchmark} · ${run.finished} of ${run.total} done`))),
		h("div", { class: "bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(run.total), "aria-valuenow": String(run.finished), "aria-label": "Challenges finished" }, h("i", { style: `width:${(run.finished / run.total) * 100}%` })),
		h("ul", { class: "jobs" }, run.jobs.map((j) => jobLine(j, run))),
		running
			? h("button", { class: "btn", type: "button", "data-key": `cancel-${run.runId}`, onclick: async () => { await api.cancelRun(run.runId).catch((e) => ctx.toast(e.message)); redraw(); } }, "Cancel run")
			: h("div", { class: "row2" },
				report?.url ? h("a", { class: "btn primary", "data-key": `report-${run.runId}`, href: report.url, target: "_blank", rel: "noopener" }, "Open report") : h("button", { class: "btn primary", type: "button", "data-key": `report-${run.runId}`, onclick: async () => {
					try {
						reports.set(run.runId, { url: api.reportUrl((await api.buildReport(run.benchmark, [run.model])).id) });
					} catch (e) {
						reports.set(run.runId, { error: e.status === 502 ? "The report service is not running." : e.message });
					}
					redraw();
				} }, "Generate report"),
				h("button", { class: "btn", type: "button", "data-key": `again-${run.runId}`, onclick: () => ctx.again(run) }, "Benchmark again")),
		report?.error ? h("p", { class: "error", role: "alert" }, report.error) : null);
}

/** Centre column while runs exist: rebuilt from the job list alone, so a page reload shows the same thing. */
export function renderRunning(ctx) {
	const root = document.getElementById("stage");
	stopRunning();
	const mine = generation;
	const redraw = async () => {
		let runs;
		try {
			runs = groupRuns(await api.jobs()).reverse().slice(0, 5);
		} catch (err) {
			return void ctx.toast(err.message);
		}
		if (mine !== generation) return;
		for (const run of runs) {
			if (run.status !== "running" && run.jobs.some((j) => !solved.has(j.id))) {
				const detail = await api.run(run.runId).catch(() => undefined);
				for (const j of detail?.jobs ?? []) solved.set(j.id, j.correct);
			}
		}
		if (mine !== generation) return;
		// The list is rebuilt on every poll, so put keyboard focus back on the same control afterwards.
		const focused = document.activeElement?.closest?.("[data-key]")?.dataset.key;
		clear(root);
		root.append(runs.length ? h("div", { class: "runs" }, runs.map((r) => runCard(ctx, r, redraw))) : h("p", { class: "empty" }, "No runs yet."));
		if (focused) root.querySelector(`[data-key="${focused}"]`)?.focus();
		const settled = settledSince(previous, runs);
		previous = new Map(runs.map((r) => [r.runId, r.status]));
		if (!runs.some((r) => r.status === "running")) stopTimer();
		if (settled) ctx.refreshModels().catch(() => {});
	};
	redraw();
	timer = setInterval(() => {
		if (!document.hidden) redraw();
	}, 3000);
}
