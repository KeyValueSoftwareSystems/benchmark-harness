import { clear, h } from "../dom.js";
import { groupModels } from "../state.js";

const collapsed = new Set();

/** Left column: the Add button under the Models heading, then one collapsible group per benchmark domain. */
export function renderModelList(ctx) {
	const root = document.getElementById("list");
	clear(root);
	const { models, selected } = ctx.state;

	root.append(h("button", { class: "btn primary add", type: "button", onclick: () => ctx.openAdd() }, "＋ Add a new model"));
	if (!models.length) root.append(h("p", { class: "empty" }, "No models yet. Add one to start."));

	for (const group of groupModels(models)) {
		const open = !collapsed.has(group.domain);
		const id = `grp-${group.domain.replace(/\W+/g, "-")}`;
		root.append(
			h("div", { class: "group" },
				h("button", { class: "group-h", type: "button", "aria-expanded": String(open), "aria-controls": id, onclick: () => (collapsed.has(group.domain) ? collapsed.delete(group.domain) : collapsed.add(group.domain), renderModelList(ctx)) },
					h("span", { "aria-hidden": "true" }, open ? "▾" : "▸"), " ", group.domain, h("span", { class: "count" }, String(group.models.length))),
				h("ul", { id, class: "items", hidden: !open },
					group.models.map((m) =>
						h("li", {},
							h("button", { class: "item", type: "button", "aria-pressed": String(m.name === selected), onclick: () => ctx.select(m.name) },
								h("span", { class: "item-name" }, m.name),
								m.readOnly ? h("span", { class: "chip" }, "add again to re-run") : m.needsKey ? h("span", { class: "chip warn" }, "needs key") : m.session ? h("span", { class: "chip" }, "session") : null))))),
		);
	}
}
