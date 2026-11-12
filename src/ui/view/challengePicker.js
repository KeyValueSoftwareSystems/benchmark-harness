import { clear, h } from "../dom.js";
import { challengeSummary, filterChallenges, toggleChallenge } from "../state.js";

/**
 * A button that opens a wide modal panel listing every challenge as a checkbox, with a filter, Select all, Clear and
 * Done. It is a native <dialog>, so focus stays inside, the page behind is inert and Escape closes it.
 * `getValue()` is "all" or the ticked ids; `onChange(next)` receives the new value.
 */
export function createChallengePicker({ list, getValue, onChange }) {
	const root = h("div", { class: "picker" });
	let query = "";
	const button = h("button", { class: "picker-btn", type: "button", "aria-haspopup": "dialog", "aria-labelledby": "pick-l pick-b", onclick: () => openPanel() });
	const label = h("span", { class: "label", id: "pick-l" }, "Challenges");
	const summary = () => button.replaceChildren(h("span", { id: "pick-b" }, challengeSummary(getValue(), list.length)), h("span", { "aria-hidden": "true" }, " ▾"));

	const panelHost = h("div", {});

	function openPanel() {
		clear(panelHost);
		const dialog = h("dialog", { class: "picker-panel", "aria-label": "Choose challenges" });
		const grid = h("ul", { class: "picker-grid" });
		const countEl = h("span", { class: "hint", role: "status" });
		const count = () => (countEl.textContent = challengeSummary(getValue(), list.length));
		const ticked = (id) => getValue() === "all" || getValue().includes(id);
		const drawGrid = () => {
			clear(grid);
			if (!list.length) return void grid.append(h("li", { class: "empty" }, "No challenges available."));
			const shown = filterChallenges(list, query);
			if (!shown.length) grid.append(h("li", { class: "empty" }, "No challenge matches that filter."));
			for (const id of shown) {
				grid.append(h("li", {}, h("label", { class: "check" },
					h("input", { type: "checkbox", checked: ticked(id), onchange: () => (onChange(toggleChallenge(getValue(), id, list)), summary(), count()) }),
					h("span", {}, id))));
			}
		};
		const search = h("input", { type: "search", "aria-label": "Filter challenges", placeholder: "Filter challenges", value: query, oninput: (e) => ((query = e.target.value), drawGrid()) });
		dialog.append(
			h("div", { class: "picker-bar" },
				search,
				countEl,
				h("button", { class: "btn", type: "button", onclick: () => (onChange("all"), drawGrid(), summary(), count()) }, "Select all"),
				h("button", { class: "btn", type: "button", onclick: () => (onChange([]), drawGrid(), summary(), count()) }, "Clear"),
				h("button", { class: "btn primary", type: "button", onclick: () => finish() }, "Done")),
			grid);
		// Closing (Done, Escape or a click on the backdrop) removes the panel and returns focus to the button.
		let done = false;
		function finish() {
			if (done) return;
			done = true;
			if (dialog.open) dialog.close();
			dialog.remove();
			summary();
			button.focus();
		}
		dialog.addEventListener("cancel", (e) => (e.preventDefault(), finish())); // Escape
		dialog.addEventListener("close", finish);
		dialog.addEventListener("click", (e) => {
			if (e.target === dialog) finish();
		});
		panelHost.append(dialog);
		drawGrid();
		count();
		dialog.showModal();
		search.focus();
	}

	summary();
	root.append(label, button, panelHost);
	return root;
}
