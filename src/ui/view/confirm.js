import { h } from "../dom.js";
import { describeItem } from "./parts.js";

/** Shows exactly what will run and spend credits, as a modal; nothing starts until Confirm. */
export function openConfirm(ctx, items) {
	const host = document.getElementById("dialogs");
	const opener = document.activeElement;
	let busy = false;
	const error = h("p", { class: "error", role: "alert" });
	const dialog = h("dialog", { class: "modal", "aria-labelledby": "confirm-h" });
	const go = h("button", { class: "btn primary", type: "button", id: "confirm-go", onclick: async () => {
		if (busy) return;
		busy = true;
		go.disabled = true;
		try {
			const done = await ctx.startItems(items);
			if (done) dialog.close();
			else {
				// Some items could not start: show only what is left, so a second click cannot start anything twice.
				busy = false;
				go.disabled = false;
				list.replaceChildren(...rows(ctx.pending()));
				if (!ctx.pending().length) dialog.close();
			}
		} catch (err) {
			error.textContent = err.message;
			busy = false;
			go.disabled = false;
		}
	} }, "Confirm and start");
	const rows = (list) => list.map((it) => h("li", {}, h("strong", {}, it.model), h("span", { class: "hint" }, `${it.benchmark} · ${describeItem(it, ctx.state.benchmarks)}`)));
	const list = h("ul", { class: "sumlist" }, rows(items));
	dialog.append(
		h("div", { class: "d-h" }, h("h2", { id: "confirm-h" }, "Ready to benchmark?"), h("button", { class: "ghost", type: "button", "aria-label": "Close", onclick: () => dialog.close() }, "✕")),
		h("div", { class: "d-b" }, list, h("div", { class: "credit" }, h("span", { "aria-hidden": "true" }, "⚠"), h("span", {}, "This uses the model's API credits. Nothing starts until you confirm.")), error),
		h("div", { class: "d-f" }, h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Back"), go));
	dialog.addEventListener("close", () => {
		dialog.remove();
		if (opener?.isConnected) opener.focus();
	});
	dialog.addEventListener("click", (e) => {
		if (e.target === dialog && !busy) dialog.close();
	});
	// While runs are being started, Escape must not hide what is happening.
	dialog.addEventListener("cancel", (e) => {
		if (busy) e.preventDefault();
	});
	host.append(dialog);
	dialog.showModal();
	go.focus();
}
