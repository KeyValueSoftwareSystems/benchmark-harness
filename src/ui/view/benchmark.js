import { clear, h } from "../dom.js";
import { canStart, filterChallenges, modelStatus, readiness, toggleChallenge } from "../state.js";
import { cardHead, COLORS, gauge, icon, seg, stat } from "./parts.js";

/**
 * Left card on the Models tab: benchmark pills top right, the selected model as the legend, the challenges (or the
 * prompt) in the main panel, then readiness and three stats, then Add to queue / Benchmark now.
 */
export function renderBenchmark(ctx) {
	const root = document.getElementById("left-card");
	clear(root);
	const s = ctx.state;
	const model = s.models.find((m) => m.name === s.selected);
	const bench = () => s.benchmarks.find((b) => b.name === s.form.benchmark);
	const set = (patch) => {
		ctx.state.form = { ...ctx.state.form, ...patch };
		refresh();
	};

	root.append(cardHead("setup", "Run setup", seg(s.benchmarks.map((b) => [b.name, b.name]), s.form.benchmark, (name) => {
		ctx.state.form = { ...ctx.state.form, benchmark: name, challenges: "all", prompt: "" };
		renderBenchmark(ctx);
	}, "Benchmark")));
	if (!model) return void root.append(h("p", { class: "empty" }, s.models.length ? "Choose a model in the table to set up a run." : "Add a model to set up a run."));

	const status = modelStatus(model);
	root.append(h("div", { class: "legend" },
		h("span", {}, h("i", { style: `background:${COLORS[0]}` }), h("b", {}, model.name)),
		h("span", {}, h("span", { class: `pill ${status.tone}` }, status.label)),
		h("span", {}, model.benchmarked.length ? `Benchmarked on ${model.benchmarked.join(", ")}` : "Not benchmarked yet")));

	const slot = h("div", { class: "main-slot" });
	root.append(slot);
	if (model.readOnly) slot.append(h("p", { class: "empty" }, "This model came from an earlier session and can't be re-run. Add it again with its key to benchmark it."));
	else if (bench()?.needsPrompt) {
		slot.append(h("div", { class: "field" }, h("label", { for: "f-prompt" }, "Prompt"),
			h("textarea", { id: "f-prompt", rows: "6", oninput: (e) => set({ prompt: e.target.value }) }, s.form.prompt)));
	} else if (bench()) slot.append(challengeGrid(ctx, bench().challenges, refresh));
	if (model.needsKey && !model.readOnly) {
		slot.append(h("div", { class: "field", style: "margin-top:14px" },
			h("label", { for: "f-key" }, "API key for this run"),
			h("input", { id: "f-key", type: "password", autocomplete: "new-password", value: s.form.apiKey, oninput: (e) => set({ apiKey: e.target.value }) }),
			h("p", { class: "hint" }, "Never stored. Held in memory until the API restarts.")));
	}

	const lower = h("div", { class: "split" });
	const hint = h("p", { class: "hint", role: "status" });
	const now = h("button", { class: "btn primary", type: "button", onclick: () => ctx.confirm([ctx.currentItem()]) }, "Benchmark now");
	const queue = h("button", { class: "btn", type: "button", onclick: () => ctx.stage() }, "Add to queue");
	root.append(lower, h("div", { class: "actions" }, queue, now, hint));

	function refresh() {
		const st = ctx.state;
		const { ok, missing } = canStart(st);
		now.disabled = queue.disabled = !ok;
		hint.textContent = ok ? "Ready. You confirm before anything spends credits." : `Still needed: ${missing.join(", ")}.`;
		const checks = readiness(st);
		const done = checks.filter((c) => c.done).length;
		const b = bench();
		const n = !b || b.needsPrompt ? 0 : st.form.challenges === "all" ? b.challenges.length : st.form.challenges.length;
		clear(lower);
		lower.append(
			h("div", {},
				h("div", { class: "sub-h" }, icon("target"), "Readiness"),
				h("div", { class: "gauge-wrap" },
					gauge(done / checks.length, ok ? "var(--green)" : "var(--violet)", "ready", `${done} of ${checks.length} checks done`),
					h("ul", { class: "checks" }, checks.map((c) => h("li", { class: c.done ? "y" : "n" }, h("i"), c.label))))),
			h("div", {},
				b?.needsPrompt
					? stat({ iconName: "bolt", label: "Prompt", value: st.form.prompt.trim() ? "Written" : "Empty", fraction: st.form.prompt.trim() ? 1 : 0, color: COLORS[0] })
					: stat({ iconName: "bolt", label: "Challenges", value: String(n), note: `of ${b?.challenges.length ?? 0}`, fraction: b?.challenges.length ? n / b.challenges.length : 0, color: COLORS[0] }),
				stat({ iconName: "key", label: "API key", value: model.needsKey ? (st.form.apiKey ? "Entered" : "Missing") : "Not needed", fraction: model.needsKey && !st.form.apiKey ? 0 : 1, color: model.needsKey && !st.form.apiKey ? "var(--warn)" : COLORS[1] }),
				stat({
					iconName: "stack", label: "Queue", value: String(st.queue.length), note: `of ${st.queueLimit}`, fraction: st.queue.length / st.queueLimit, color: COLORS[2],
					extra: st.queue.length ? h("button", { class: "btn sm go", type: "button", id: "start-queue", onclick: () => ctx.confirm(ctx.state.queue) }, `Start queue (${st.queue.length})`) : null,
				})));
	}
	refresh();
}

/** The challenges as toggle chips with a filter, Select all and Clear: the main panel of the setup card. */
function challengeGrid(ctx, list, onChange) {
	const wrap = h("div", {});
	const grid = h("div", { class: "chips", role: "group", "aria-label": "Challenges" });
	const value = () => ctx.state.form.challenges;
	const put = (next) => {
		ctx.state.form = { ...ctx.state.form, challenges: next };
		draw();
		onChange();
	};
	function draw() {
		clear(grid);
		if (!list.length) return void grid.append(h("p", { class: "hint" }, "No challenges available."));
		const shown = filterChallenges(list, ctx.ui.challengeQuery);
		if (!shown.length) return void grid.append(h("p", { class: "hint" }, "No challenge matches that filter."));
		for (const id of shown) {
			const on = value() === "all" || value().includes(id);
			const box = h("span", { class: "box" });
			if (on) box.append(icon("check", "", "0 0 12 12"));
			grid.append(h("button", { class: "chip", type: "button", "aria-pressed": String(on), onclick: () => put(toggleChallenge(value(), id, list)) }, box, id));
		}
	}
	wrap.append(
		h("div", { class: "chips-bar" },
			h("label", { class: "sr", for: "f-filter" }, "Filter challenges"),
			h("input", { class: "search", id: "f-filter", type: "search", placeholder: "Filter challenges", value: ctx.ui.challengeQuery, oninput: (e) => ((ctx.ui.challengeQuery = e.target.value), draw()) }),
			h("button", { class: "btn sm", type: "button", onclick: () => put("all") }, "Select all"),
			h("button", { class: "btn sm", type: "button", onclick: () => put([]) }, "Clear")),
		grid);
	draw();
	return wrap;
}
