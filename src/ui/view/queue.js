import { clear, h } from "../dom.js";

/** Right column: models staged in this browser (nothing runs until "Benchmark these" is confirmed). */
export function renderQueue(ctx) {
	const root = document.getElementById("queue");
	clear(root);
	const { queue } = ctx.state;
	root.append(
		queue.length
			? h("ul", { class: "queue" }, queue.map((q, i) =>
				h("li", {}, h("span", {}, h("strong", {}, q.model), h("small", { class: "hint" }, ` ${q.benchmark}`)),
					h("button", { class: "icon-btn small", type: "button", "aria-label": `Remove ${q.model} from the queue`, onclick: () => ctx.unstage(i) }, "✕"))))
			: h("p", { class: "empty" }, "Nothing queued. Use Add to queue on a model."),
		h("button", { class: "btn primary", type: "button", disabled: queue.length === 0, onclick: () => ctx.confirm(ctx.state.queue) }, "Benchmark these"));
}
