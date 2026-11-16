import { clear, h } from "../dom.js";
import { lastRunOf, verdicts } from "../runs.js";
import { benchmarkNames, filterModels, modelStatus, runStats, sortByResult } from "../state.js";
import { ago, cardHead, COLORS, modelIcon } from "./parts.js";

/** Right card on the Models tab: every model as a ranked row, filterable by benchmark, sortable by its last result. */
export function renderModelList(ctx) {
	const root = document.getElementById("right-card");
	clear(root);
	const { models, selected } = ctx.state;
	const ui = ctx.ui;

	const filter = h("select", { class: "select", "aria-label": "Filter models by benchmark", onchange: (e) => ((ui.filter = e.target.value), renderModelList(ctx)) },
		[["all", "All benchmarks"], ...benchmarkNames(models).map((b) => [b, b]), ["none", "Not benchmarked"]].map(([v, t]) => h("option", { value: v, selected: ui.filter === v }, t)));
	root.append(cardHead("trophy", "Models", filter, { gold: true, id: "models-h" }));

	const result = (m) => {
		const run = lastRunOf(m.name);
		if (!run || run.status === "running") return undefined;
		const st = runStats(run, verdicts);
		return st.total ? st.solved / st.total : undefined;
	};
	let list = filterModels(models, ui.filter);
	if (ui.sort) list = sortByResult(list, result, ui.sort);

	const sortLabel = ui.sort === "desc" ? "highest first" : ui.sort === "asc" ? "lowest first" : "not sorted";
	const head = h("tr", {},
		h("th", { scope: "col" }, "#"),
		h("th", { scope: "col" }, "Model"),
		h("th", { scope: "col", "aria-sort": ui.sort === "desc" ? "descending" : ui.sort === "asc" ? "ascending" : "none" },
			h("button", { type: "button", "aria-label": `Last result, ${sortLabel}. Click to sort.`, onclick: () => ((ui.sort = ui.sort === "desc" ? "asc" : "desc"), renderModelList(ctx)) }, "Last result", h("span", { "aria-hidden": "true" }, ui.sort === "asc" ? " ↑" : " ↓"))),
		h("th", { scope: "col", class: "hide-sm" }, "Benchmarked on"),
		h("th", { scope: "col", class: "hide-sm" }, "Last run"),
		h("th", { scope: "col" }, "Status"));

	const body = h("tbody", {});
	list.forEach((m, i) => {
		const status = modelStatus(m);
		const run = lastRunOf(m.name);
		const st = run ? runStats(run, verdicts) : null;
		const choose = () => ctx.select(m.name);
		body.append(h("tr", { class: "row", tabindex: "0", "aria-selected": String(m.name === selected), onclick: choose, onkeydown: (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), choose()) },
			h("td", { class: "rank" }, String(i + 1)),
			h("td", {}, h("div", { class: "mname" }, modelIcon(m.name), h("span", { class: "n" }, m.name), m.name === selected ? h("span", { class: "tagp" }, "★ Selected") : null)),
			h("td", { class: "scorecell" }, st
				? [h("b", {}, run.status === "running" ? `Running · ${st.finished} of ${st.total} done` : `${st.solved} of ${st.total} solved`),
					h("div", { class: "sbar" }, h("i", { style: `width:${st.total ? (st.solved / st.total) * 100 : 0}%;background:${COLORS[i % 3]}` }))]
				: h("span", { class: "hint" }, "No runs yet")),
			h("td", { class: "hide-sm" }, m.benchmarked.length ? h("div", { class: "tags" }, m.benchmarked.map((b) => h("span", { class: "tag" }, b))) : h("span", { class: "hint" }, "—")),
			h("td", { class: "hide-sm" }, h("span", { class: "hint" }, run ? ago(run.jobs[0]?.createdAt) : "—")),
			h("td", {}, h("span", { class: `pill ${status.tone}` }, status.label))));
	});
	if (!list.length) body.append(h("tr", {}, h("td", { colspan: "6", class: "empty" }, models.length ? "No model matches that filter." : "No models yet. Use Add model to start.")));
	root.append(h("div", { class: "tbl" }, h("table", { "aria-labelledby": "models-h" }, h("thead", {}, head), body)));
}
