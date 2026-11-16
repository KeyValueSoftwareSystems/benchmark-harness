import { clear, h } from "../dom.js";
import { describeQueueItem } from "../state.js";
import { cardHead, COLORS, describeItem, gauge, icon, modelIcon, stat } from "./parts.js";

const open = new WeakSet(); // queued items whose settings are showing

/** The Queue tab: left = what will start and "Benchmark these"; right = the queued setups, each with info and remove. */
export function renderQueue(ctx) {
	const left = document.getElementById("left-card");
	const right = document.getElementById("right-card");
	clear(left);
	clear(right);
	const { queue, queueLimit, benchmarks } = ctx.state;

	left.append(cardHead("setup", "Start the queue", null));
	left.append(h("div", { class: "legend" }, queue.slice(0, 3).map((q, i) => h("span", {}, h("i", { style: `background:${COLORS[i % 3]}` }), q.model))));
	left.append(h("div", { class: "main-slot" }, queue.length
		? [h("ul", { class: "sumlist" }, queue.map((q) => h("li", {}, h("strong", {}, q.model), h("span", { class: "hint" }, `${q.benchmark} · ${describeItem(q, benchmarks)}`)))),
			h("div", { class: "credit" }, h("span", { "aria-hidden": "true" }, "⚠"), h("span", {}, "Each setup uses that model's API credits. You confirm once more before they start."))]
		: h("p", { class: "empty" }, "Nothing queued. Use Add to queue in Run setup on the Models tab.")));
	const challenges = queue.reduce((n, q) => {
		const b = benchmarks.find((x) => x.name === q.benchmark);
		return n + (b?.needsPrompt ? 1 : q.challenges === "all" ? b?.challenges.length ?? 0 : q.challenges.length);
	}, 0);
	const keys = queue.filter((q) => q.apiKey).length;
	left.append(h("div", { class: "split" },
		h("div", {}, h("div", { class: "sub-h" }, icon("target"), "Capacity"),
			h("div", { class: "gauge-wrap" }, gauge(queue.length / queueLimit, "var(--violet)", "used", `${queue.length} of ${queueLimit} queue slots used`),
				h("ul", { class: "checks" }, h("li", { class: queue.length ? "y" : "n" }, h("i"), `${queue.length} queued`), h("li", { class: "n" }, h("i"), `${queueLimit - queue.length} free`)))),
		h("div", {},
			stat({ iconName: "stack", label: "Setups", value: String(queue.length), note: `of ${queueLimit}`, fraction: queue.length / queueLimit, color: COLORS[2] }),
			stat({ iconName: "bolt", label: "Jobs to run", value: String(challenges), fraction: Math.min(1, challenges / 20), color: COLORS[0] }),
			stat({ iconName: "key", label: "Keys held in memory", value: String(keys), fraction: queue.length ? keys / queue.length : 0, color: COLORS[1] }))));
	left.append(h("div", { class: "actions" }, h("button", { class: "btn primary", type: "button", id: "bench-these", disabled: queue.length === 0, onclick: () => ctx.confirm(ctx.state.queue) }, "Benchmark these")));

	right.append(cardHead("trophy", "Queue", h("span", { class: "hint" }, `${queue.length} of ${queueLimit} in the queue`), { gold: true, id: "queue-h" }));
	const body = h("tbody", {});
	queue.forEach((q, i) => {
		const showing = open.has(q);
		const id = `qi-${i}`;
		body.append(h("tr", {},
			h("td", { class: "rank" }, String(i + 1)),
			h("td", {}, h("div", { class: "mname" }, modelIcon(q.model), h("span", { class: "n" }, q.model))),
			h("td", {}, h("span", { class: "tag" }, q.benchmark)),
			h("td", { class: "hide-sm" }, describeItem(q, benchmarks)),
			h("td", { style: "white-space:nowrap;text-align:right" },
				h("button", { class: "ghost", type: "button", "aria-expanded": String(showing), "aria-controls": id, "aria-label": `Settings for ${q.model}`, onclick: () => {
					if (showing) open.delete(q);
					else open.add(q);
					renderQueue(ctx);
					document.querySelector(`[aria-controls="${id}"]`)?.focus();
				} }, "ⓘ"),
				h("button", { class: "ghost", type: "button", "aria-label": `Remove ${q.model} from the queue`, onclick: () => ctx.unstage(i) }, "✕"))));
		if (showing) body.append(h("tr", { class: "qinfo", id }, h("td", {}), h("td", { colspan: "4" }, h("dl", {}, describeQueueItem(q, benchmarks).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])))));
	});
	if (!queue.length) body.append(h("tr", {}, h("td", { colspan: "5", class: "empty" }, "The queue is empty.")));
	right.append(h("div", { class: "tbl" }, h("table", { "aria-labelledby": "queue-h" },
		h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "#"), h("th", { scope: "col" }, "Model"), h("th", { scope: "col" }, "Benchmark"), h("th", { scope: "col", class: "hide-sm" }, "Runs"), h("th", { scope: "col" }, h("span", { class: "sr" }, "Actions")))),
		body)));
}
