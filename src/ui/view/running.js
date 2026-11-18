import { api } from "../api.js";
import { clear, h } from "../dom.js";
import { currentRuns, loadRuns, verdicts } from "../runs.js";
import { formatElapsed, runStats, settledSince, solveCurve, summarizeError } from "../state.js";
import { ago, cardHead, COLORS, icon, modelIcon, seg, stat } from "./parts.js";

let timer = null;
let generation = 0; // a poll that finishes after the view changed must not paint
const reports = new Map(); // runId -> { url } | { error } | { busy: true }
let previous = new Map(); // runId -> status at the last poll

const stopTimer = () => {
	clearInterval(timer);
	timer = null;
};
export const stopRunning = () => {
	generation++;
	stopTimer();
};

const JOB = { queued: ["Waiting", "mute"], provisioning: ["Starting", "run"], running: ["Running", "run"], error: ["Failed", "bad"], cancelled: ["Cancelled", "mute"] };
const RUN = { running: ["Running", "run"], done: ["Done", "ok"], error: ["Has errors", "bad"], cancelled: ["Cancelled", "mute"] };
const spinner = () => h("span", { class: "spin", "aria-hidden": "true" });
const shortName = (m) => m.split("/").pop();

function jobPill(job) {
	if (job.status === "done") {
		const v = verdicts.get(job.id);
		return v === true ? h("span", { class: "pill ok" }, "Solved") : v === false ? h("span", { class: "pill bad" }, "Not solved") : h("span", { class: "pill ok" }, "Finished");
	}
	const [label, tone] = JOB[job.status] ?? [job.status, "mute"];
	const elapsed = job.status === "running" || job.status === "provisioning" ? ` · ${formatElapsed(Date.now() - Date.parse(job.createdAt))}` : "";
	return h("span", { class: `pill ${tone}` }, tone === "run" ? spinner() : null, label + elapsed);
}

function errorLine(text) {
	const short = summarizeError(text);
	return text === short ? h("div", { class: "err" }, h("span", { class: "short" }, short)) : h("details", { class: "err" }, h("summary", {}, h("span", { class: "short" }, short), " · Details"), h("pre", {}, text));
}

/** Solved count after each finished challenge, one line per run; numbers only go into the SVG. */
function chart(pool, selectedId) {
	const W = 640, H = 230, L = 36, R = 18, T = 14, B = 30;
	const maxX = Math.max(1, ...pool.map((r) => r.jobs.length));
	const maxY = Math.max(1, ...pool.map((r) => r.jobs.length));
	const x = (i) => L + (i / maxX) * (W - L - R);
	const y = (v) => T + (1 - v / maxY) * (H - T - B);
	const yStep = Math.max(1, Math.ceil(maxY / 5));
	const xStep = Math.max(1, Math.ceil(maxX / 8));
	let svg = "";
	for (let v = 0; v <= maxY; v += yStep) svg += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 10}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
	for (let i = 0; i <= maxX; i += xStep) svg += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${i}</text>`;
	pool.forEach((run, k) => {
		const curve = solveCurve(run, verdicts);
		const pts = curve.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
		const on = run.runId === selectedId;
		const color = COLORS[k % 3];
		const [ex, ey] = [x(curve.length - 1), y(curve.at(-1))];
		svg += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${on ? 3 : 2}" stroke-opacity="${on ? 1 : 0.55}" stroke-linejoin="round"/><circle cx="${ex}" cy="${ey}" r="${on ? 5 : 3.5}" fill="${color}"/>`;
		if (on) {
			const bx = Math.min(ex + 10, W - R - 100);
			const by = Math.max(T, ey - 40);
			svg += `<line x1="${ex}" x2="${ex}" y1="${ey}" y2="${H - B}" stroke="${color}" stroke-dasharray="3 3" stroke-opacity=".6"/><rect class="tip" x="${bx}" y="${by}" width="96" height="30" rx="8"/><circle cx="${bx + 14}" cy="${by + 15}" r="4" fill="${color}"/><text class="tip-t" x="${bx + 24}" y="${by + 20}">${curve.at(-1)} solved</text>`;
		}
	});
	const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	el.setAttribute("class", "chart");
	el.setAttribute("viewBox", `0 0 ${W} ${H}`);
	el.setAttribute("role", "img");
	el.setAttribute("aria-label", `Challenges solved, counted after each finished challenge, for ${pool.length} run${pool.length === 1 ? "" : "s"}`);
	el.innerHTML = svg;
	return el;
}

function leftCard(ctx, runs, redraw) {
	const root = document.getElementById("left-card");
	clear(root);
	const run = runs.find((r) => r.runId === ctx.ui.runSel) ?? runs[0];
	if (!run) {
		root.append(cardHead("setup", "Run progress", null), h("p", { class: "empty" }, "No runs yet. Start one from the Models tab."));
		return;
	}
	const pool = [run, ...runs.filter((r) => r.benchmark === run.benchmark && r.runId !== run.runId)].slice(0, 3);
	root.append(cardHead("setup", "Run progress", h("span", { class: "tag" }, run.benchmark)));
	root.append(h("div", { class: "legend" }, pool.map((r, k) => h("span", {}, h("i", { style: `background:${COLORS[k % 3]}` }), r.runId === run.runId ? h("b", {}, shortName(r.model)) : shortName(r.model)))));
	root.append(h("div", { class: "main-slot" }, chart(pool, run.runId), h("p", { class: "hint", style: "text-align:center" }, "Challenges finished (x) against challenges solved (y)")));

	const st = runStats(run, verdicts);
	root.append(h("div", { class: "split" },
		h("div", {},
			h("div", { class: "sub-h" }, icon("list"), `${run.model} · ${ago(run.jobs[0]?.createdAt)}`),
			h("ul", { class: "joblist" }, run.jobs.map((j) => h("li", {}, h("div", {}, j.params?.challenge ?? "prompt", j.error ? errorLine(j.error) : null), jobPill(j))))),
		h("div", {},
			stat({ iconName: "bolt", label: "Solved", value: String(st.solved), note: `of ${st.total}`, fraction: st.total ? st.solved / st.total : 0, color: "var(--green)" }),
			stat({ iconName: "flag", label: "Finished", value: String(st.finished), note: `of ${st.total}`, fraction: st.total ? st.finished / st.total : 0, color: COLORS[0] }),
			stat({ iconName: "x", label: "Errors", value: String(st.errors), note: st.errors ? "see details" : "", fraction: st.total ? st.errors / st.total : 0, color: "var(--bad)" }))));

	const report = reports.get(run.runId);
	const actions = h("div", { class: "actions" });
	if (run.status === "running") {
		actions.append(h("button", { class: "btn", type: "button", "data-key": `cancel-${run.runId}`, onclick: async () => {
			await api.cancelRun(run.runId).catch((e) => ctx.toast(e.message));
			redraw();
		} }, "Cancel run"));
	} else {
		actions.append(h("button", { class: "btn", type: "button", "data-key": `again-${run.runId}`, onclick: () => ctx.again(run) }, "Benchmark again"));
		if (report?.url) actions.append(h("a", { class: "btn primary", "data-key": `report-${run.runId}`, id: "open-report", href: report.url, target: "_blank", rel: "noopener" }, "Open report"));
		else {
			actions.append(h("button", { class: "btn primary", type: "button", "data-key": `report-${run.runId}`, id: "generate-report", disabled: !!report?.busy, onclick: async () => {
				reports.set(run.runId, { busy: true });
				redraw(false);
				try {
					reports.set(run.runId, { url: api.reportUrl((await api.buildReport(run.benchmark, [run.model])).id) });
					ctx.toast("Report ready");
				} catch (e) {
					reports.set(run.runId, { error: e.status === 502 ? "The report service is not running." : e.message });
				}
				redraw(false);
			} }, report?.busy ? "Generating report…" : "Generate report"));
		}
	}
	if (report?.error) actions.append(h("p", { class: "error", role: "alert" }, report.error));
	root.append(actions);
}

function rightCard(ctx, runs, redraw) {
	const root = document.getElementById("right-card");
	clear(root);
	const ui = ctx.ui;
	const filter = h("select", { class: "select", "aria-label": "Filter runs", onchange: (e) => ((ui.runFilter = e.target.value), redraw(false)) },
		[["all", "All runs"], ["running", "Running"], ["finished", "Finished"]].map(([v, t]) => h("option", { value: v, selected: ui.runFilter === v }, t)));
	root.append(cardHead("trophy", "Runs", filter, { gold: true, id: "runs-h" }));
	const shown = runs.filter((r) => ui.runFilter === "all" || (ui.runFilter === "running") === (r.status === "running"));
	const current = (runs.find((r) => r.runId === ui.runSel) ?? runs[0])?.runId;
	const body = h("tbody", {});
	shown.forEach((r, i) => {
		const st = runStats(r, verdicts);
		const [label, tone] = RUN[r.status] ?? [r.status, "mute"];
		const choose = () => {
			ui.runSel = r.runId;
			redraw(false);
		};
		body.append(h("tr", { class: "row", tabindex: "0", "data-key": `run-${r.runId}`, "aria-selected": String(r.runId === current), onclick: choose, onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose()) },
			h("td", { class: "rank" }, String(i + 1)),
			h("td", {}, h("div", { class: "mname" }, modelIcon(r.model), h("span", { class: "n" }, r.model), r.status === "running" ? h("span", { class: "tagp" }, "● Live") : null)),
			h("td", { class: "scorecell" }, h("b", {}, `${st.solved} of ${st.total} solved · ${st.finished} done`), h("div", { class: "sbar" }, h("i", { style: `width:${st.total ? (st.solved / st.total) * 100 : 0}%;background:${COLORS[i % 3]}` }))),
			h("td", { class: "hide-sm" }, h("span", { class: "tag" }, r.benchmark)),
			h("td", { class: "hide-sm" }, h("span", { class: "hint" }, ago(r.jobs[0]?.createdAt))),
			h("td", {}, h("span", { class: `pill ${tone}` }, tone === "run" ? spinner() : null, label))));
	});
	if (!shown.length) body.append(h("tr", {}, h("td", { colspan: "6", class: "empty" }, runs.length ? "No runs match that filter." : "No runs yet.")));
	root.append(h("div", { class: "tbl" }, h("table", { "aria-labelledby": "runs-h" },
		h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "#"), h("th", { scope: "col" }, "Model"), h("th", { scope: "col" }, "Solved"), h("th", { scope: "col", class: "hide-sm" }, "Benchmark"), h("th", { scope: "col", class: "hide-sm" }, "Started"), h("th", { scope: "col" }, "Status"))),
		body)));
}

/** The Runs tab, rebuilt from the job list alone, so a page reload shows the same thing. Polls while anything runs. */
export function renderRunning(ctx) {
	stopRunning();
	const mine = generation;
	const paint = (runs) => {
		// Both cards are rebuilt, so put keyboard focus back on the same control afterwards.
		const focused = document.activeElement?.closest?.("[data-key]")?.dataset.key;
		leftCard(ctx, runs, redraw);
		rightCard(ctx, runs, redraw);
		if (focused) document.querySelector(`[data-key="${focused}"]`)?.focus();
	};
	async function redraw(fetch = true) {
		if (!fetch) return void paint(currentRuns());
		let runs;
		try {
			runs = await loadRuns();
		} catch (err) {
			return void ctx.toast(err.message);
		}
		if (mine !== generation) return;
		paint(runs);
		ctx.updateCounts();
		const settled = settledSince(previous, runs);
		previous = new Map(runs.map((r) => [r.runId, r.status]));
		if (!runs.some((r) => r.status === "running")) stopTimer();
		if (settled) ctx.refreshModels().catch(() => {});
	}
	paint(currentRuns());
	redraw();
	timer = setInterval(() => {
		if (!document.hidden && !document.querySelector("details[open]")) redraw();
	}, 3000);
}
