import { clear, h } from "../dom.js";
import { describeQueueItem } from "../state.js";

const open = new WeakSet(); // queued items whose settings are showing

/** Right column: models staged in this browser (nothing runs until "Benchmark these" is confirmed). */
export function renderQueue(ctx) {
	const root = document.getElementById("queue");
	clear(root);
	const { queue, benchmarks, queueLimit } = ctx.state;
	root.append(
		queue.length
			? h("ul", { class: "queue" }, queue.map((q, i) => {
				const showing = open.has(q);
				const id = `qi-${i}`;
				return h("li", {},
					h("div", { class: "qrow" },
						h("span", {}, h("strong", {}, q.model), h("small", { class: "hint" }, ` ${q.benchmark}`)),
						h("span", { class: "qbtns" },
							h("button", { class: "icon-btn small", type: "button", "aria-expanded": String(showing), "aria-controls": id, "aria-label": `Settings for ${q.model}`, onclick: () => (showing ? open.delete(q) : open.add(q), renderQueue(ctx)) }, "ⓘ"),
							h("button", { class: "icon-btn small", type: "button", "aria-label": `Remove ${q.model} from the queue`, onclick: () => ctx.unstage(i) }, "✕"))),
					h("dl", { id, class: "qinfo", hidden: !showing }, describeQueueItem(q, benchmarks).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])));
			}))
			: h("p", { class: "empty" }, "Nothing queued. Use Add to queue on a model."),
		queue.length ? h("p", { class: "hint" }, `${queue.length} of ${queueLimit} in the queue`) : null,
		h("button", { class: "btn primary", type: "button", disabled: queue.length === 0, onclick: () => ctx.confirm(ctx.state.queue) }, "Benchmark these"));
}
