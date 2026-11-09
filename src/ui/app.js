import { api } from "./api.js";
import { clear, h } from "./dom.js";
import { createState, selectModel } from "./state.js";
import { renderAddModel } from "./view/addModel.js";
import { renderModelList } from "./view/modelList.js";
import { applyTheme, loadTheme, nextTheme, saveTheme } from "./theme.js";

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/></svg>';

export const app = { state: createState(), adding: false };

export function toast(message) {
	const el = document.getElementById("toast");
	el.textContent = message;
	el.classList.add("show");
	setTimeout(() => el.classList.remove("show"), 3500);
}

function setupTheme() {
	const button = document.getElementById("theme");
	let theme = loadTheme();
	const show = () => {
		applyTheme(theme);
		// the icon shows what a click switches to
		button.innerHTML = theme === "dark" ? SUN : MOON;
		button.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
	};
	button.addEventListener("click", () => {
		theme = nextTheme(theme);
		saveTheme(theme);
		show();
	});
	show();
}

async function load() {
	const [{ models, discovery }, benchmarks] = await Promise.all([api.models(), api.benchmarks()]);
	app.state = { ...app.state, models, discovery, benchmarks };
}

const ctx = {
	get state() {
		return app.state;
	},
	toast,
	reload: async () => {
		await load();
		render();
	},
	select(name) {
		app.state = selectModel(app.state, name);
		app.adding = false;
		render();
	},
	openAdd() {
		app.adding = true;
		render();
	},
	closeAdd(select) {
		app.adding = false;
		if (select) app.state = selectModel(app.state, select);
		render();
	},
};

function render() {
	renderModelList(ctx);
	if (app.adding) renderAddModel(ctx);
	else {
		const stage = document.getElementById("stage");
		clear(stage);
		stage.append(h("p", { class: "empty" }, app.state.selected ? `Selected: ${app.state.selected}` : "Choose a model on the left, or add a new one."));
	}
}

setupTheme();
load().then(render).catch((err) => toast(err.message));
