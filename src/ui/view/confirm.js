import { clear, h } from "../dom.js";

const describe = (ctx, item) => {
	const bench = ctx.state.benchmarks.find((b) => b.name === item.benchmark);
	if (bench?.needsPrompt) return "1 prompt";
	const n = item.challenges === "all" ? bench?.challenges.length ?? 0 : item.challenges.length;
	return `${n} challenge${n === 1 ? "" : "s"}${item.challenges === "all" ? " (all)" : ""}`;
};

/** Shows exactly what will run and spend credits; nothing starts until Confirm. */
export function renderConfirm(ctx, items) {
	const root = document.getElementById("stage");
	clear(root);
	let busy = false;
	const error = h("p", { class: "error", role: "alert" });
	const go = h("button", { class: "btn primary", type: "button", onclick: async () => {
		if (busy) return;
		busy = true;
		go.disabled = true;
		try {
			await ctx.startItems(items);
		} catch (err) {
			error.textContent = err.message;
			busy = false;
			go.disabled = false;
		}
	} }, "Confirm and start");
	root.append(
		h("div", { class: "card" },
			h("h3", {}, "Ready to benchmark?"),
			h("p", { class: "hint" }, "This uses the model's API credits."),
			h("ul", { class: "summary" }, items.map((it) => h("li", {}, h("strong", {}, it.model), ` on ${it.benchmark}: ${describe(ctx, it)}`))),
			error,
			h("div", { class: "row2" }, h("button", { class: "btn", type: "button", onclick: () => ctx.back() }, "Back"), go)));
}
