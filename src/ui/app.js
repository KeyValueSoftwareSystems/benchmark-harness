import { api } from "./api.js";
import { clear, h } from "./dom.js";
import { againForm, createState, groupRuns, runItems, removeStaged, selectModel, stageRun } from "./state.js";
import { renderAddModel } from "./view/addModel.js";
import { renderBenchmark } from "./view/benchmark.js";
import { renderConfirm } from "./view/confirm.js";
import { renderQueue } from "./view/queue.js";
import { renderRunning, stopRunning } from "./view/running.js";
import { renderModelList } from "./view/modelList.js";
import { applyTheme, loadTheme, nextTheme, saveTheme } from "./theme.js";

const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/></svg>';

export const app = { state: createState(), view: "stage", pending: [], runs: [] };

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
	set state(next) {
		app.state = next;
	},
	toast,
	reload: async () => {
		await load();
		render();
	},
	select(name) {
		app.state = selectModel(app.state, name);
		app.view = "stage";
		render();
	},
	openAdd() {
		app.view = "add";
		render();
	},
	closeAdd(select) {
		app.view = "stage";
		if (select) app.state = selectModel(app.state, select);
		render();
	},
	again(run) {
		app.state = { ...selectModel(app.state, run.model), form: { ...app.state.form, ...againForm(run, app.state.benchmarks), apiKey: "" } };
		app.view = "stage";
		render();
	},
	currentItem: () => stageRun({ ...app.state, queue: [] }).queue[0],
	stage() {
		app.state = { ...stageRun(app.state), form: { ...app.state.form, apiKey: "" } };
		render();
		toast("Added to the queue");
	},
	unstage(i) {
		app.state = removeStaged(app.state, i);
		render();
	},
	confirm(items) {
		app.view = "confirm";
		app.pending = items;
		render();
	},
	back() {
		app.view = "stage";
		render();
	},
	/** Hands any key to the API (memory only), then starts one run per item. Each item leaves the queue the moment its run starts. */
	async startItems(items) {
		const { started, failed, error } = await runItems(
			items,
			async (it) => {
				const model = app.state.models.find((m) => m.name === it.model);
				if (model?.needsKey && it.apiKey) await api.setKey(it.model, it.apiKey);
				return (await api.startRun({ benchmark: it.benchmark, model: it.model, challenges: it.challenges, prompt: it.prompt })).runId;
			},
			(it) => {
				app.state = { ...app.state, queue: app.state.queue.filter((q) => q !== it), form: { ...app.state.form, apiKey: "" } };
				app.pending = app.pending.filter((p) => p !== it);
			},
		);
		app.runs = [...started, ...app.runs];
		if (failed) {
			// Stay on the confirmation with only what has not started, so a second click cannot start anything twice.
			toast(`${started.length ? `${started.length} started. ` : ""}${failed.model} could not start: ${error.message}`);
			await load().catch(() => {});
			return render();
		}
		app.view = "running";
		await load();
		render();
	},
	/** Reloads the model list after a run settles, without redrawing the running view. */
	async refreshModels() {
		await load();
		renderModelList(ctx);
		renderQueue(ctx);
	},
};

function render() {
	if (app.view !== "running") stopRunning();
	renderModelList(ctx);
	renderQueue(ctx);
	if (app.view === "add") renderAddModel(ctx);
	else if (app.view === "confirm") renderConfirm(ctx, app.pending);
	else if (app.view === "running") renderRunning(ctx);
	else renderBenchmark(ctx);
}

document.getElementById("runs").addEventListener("click", () => {
	app.view = app.view === "running" ? "stage" : "running";
	render();
});

// Open on the running view when something is already running (a reload mid-run shows the same screen).
const resumeRuns = async () => {
	const runs = groupRuns(await api.jobs().catch(() => []));
	if (runs.some((r) => r.status === "running")) app.view = "running";
};

setupTheme();
load().then(resumeRuns).then(render).catch((err) => toast(err.message));
