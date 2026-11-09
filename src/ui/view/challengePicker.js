import { clear, h } from "../dom.js";
import { challengeSummary, filterChallenges, toggleChallenge } from "../state.js";

/**
 * A button that opens a wide panel over the page listing every challenge as a checkbox, with a filter, Select all,
 * Clear and Done. `getValue()` is "all" or the ticked ids; `onChange(next)` receives the new value.
 */
export function createChallengePicker({ list, getValue, onChange }) {
	const root = h("div", { class: "picker" });
	let open = false;
	let query = "";
	const button = h("button", { class: "picker-btn", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", onclick: () => toggle(true) });
	const label = h("span", { class: "label", id: "pick-l" }, "Challenges");

	const close = () => toggle(false);
	const onKey = (e) => {
		if (e.key === "Escape") close();
	};
	function toggle(next) {
		open = next;
		drawPanel();
		button.setAttribute("aria-expanded", String(open));
		if (open) document.addEventListener("keydown", onKey);
		else {
			document.removeEventListener("keydown", onKey);
			button.focus();
		}
		summary();
	}
	const summary = () => {
		button.replaceChildren(h("span", {}, challengeSummary(getValue(), list.length)), h("span", { "aria-hidden": "true" }, " ▾"));
	};

	const panelHost = h("div", {});
	function drawPanel() {
		clear(panelHost);
		if (!open) return;
		const value = getValue();
		const ticked = (id) => value === "all" || value.includes(id);
		const grid = h("ul", { class: "picker-grid" });
		const drawGrid = () => {
			clear(grid);
			const shown = filterChallenges(list, query);
			if (!shown.length) grid.append(h("li", { class: "empty" }, "No challenge matches that filter."));
			for (const id of shown) {
				grid.append(h("li", {}, h("label", { class: "check" },
					h("input", { type: "checkbox", checked: ticked(id), onchange: () => (onChange(toggleChallenge(getValue(), id, list)), summary(), count()) }),
					h("span", {}, id))));
			}
		};
		const countEl = h("span", { class: "hint", role: "status" });
		const count = () => (countEl.textContent = challengeSummary(getValue(), list.length));
		const search = h("input", { type: "search", id: "pick-q", "aria-label": "Filter challenges", placeholder: "Filter challenges", value: query, oninput: (e) => ((query = e.target.value), drawGrid()) });
		panelHost.append(
			h("div", { class: "picker-backdrop", onclick: close }),
			h("div", { class: "picker-panel", role: "dialog", "aria-modal": "true", "aria-label": "Choose challenges" },
				h("div", { class: "picker-bar" },
					search,
					countEl,
					h("button", { class: "btn", type: "button", onclick: () => (onChange("all"), drawPanel(), summary()) }, "Select all"),
					h("button", { class: "btn", type: "button", onclick: () => (onChange([]), drawPanel(), summary()) }, "Clear"),
					h("button", { class: "btn primary", type: "button", onclick: close }, "Done")),
				grid));
		drawGrid();
		count();
		search.focus();
	}

	summary();
	root.append(label, button, panelHost);
	return root;
}
