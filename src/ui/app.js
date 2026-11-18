import { api } from "./api.js";
import { currentRuns, loadRuns } from "./runs.js";
import { againForm, createState, groupRuns, removeStaged, runItems, selectModel, stageCheck, stageRun } from "./state.js";
import { openAddModel } from "./view/addModel.js";
import { renderBenchmark } from "./view/benchmark.js";
import { openConfirm } from "./view/confirm.js";
import { renderModelList } from "./view/modelList.js";
import { renderQueue } from "./view/queue.js";
import { renderRunning, stopRunning } from "./view/running.js";
import { hasSeenTour, startTour } from "./tour.js";
import { applyTheme, loadTheme, nextTheme, saveTheme } from "./theme.js";

export const app = { state: createState(), view: "models", pending: [], heroSlim: false };
/** View-only choices that survive a redraw but are not part of what runs. */
const ui = { filter: "all", sort: null, challengeQuery: "", runSel: null, runFilter: "all" };

export function toast(message) {
	const el = document.getElementById("toast");
	el.textContent = message;
	el.classList.add("show");
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => el.classList.remove("show"), 3500);
}

function setupTheme() {
	const button = document.getElementById("theme");
	let theme = loadTheme();
	const show = () => {
		applyTheme(theme);
		// the label says what a click switches to
		button.textContent = theme === "dark" ? "Light theme" : "Dark theme";
	};
	button.addEventListener("click", () => {
		theme = nextTheme(theme);
		saveTheme(theme);
		show();
	});
	show();
}

function apiStatus(ok) {
	const el = document.getElementById("api-status");
	el.dataset.state = ok ? "ok" : "down";
	el.textContent = ok ? "Harness API connected" : "Can't reach the harness API";
}

async function load() {
	try {
		const [{ models, discovery, queueLimit }, benchmarks] = await Promise.all([api.models(), api.benchmarks()]);
		app.state = { ...app.state, models, discovery, queueLimit: queueLimit ?? 5, benchmarks };
		if (!benchmarks.some((b) => b.name === app.state.form.benchmark) && benchmarks[0]) app.state.form = { ...app.state.form, benchmark: benchmarks[0].name, challenges: "all", prompt: "" };
		apiStatus(true);
	} catch (err) {
		apiStatus(false);
		throw err;
	}
}

/** The hero is full-size on arrival and slim once work starts, so the cards sit higher on the screen. */
function slimHero() {
	if (app.heroSlim) return;
	app.heroSlim = true;
	document.getElementById("hero").classList.add("slim");
}

function updateCounts() {
	const runs = document.getElementById("runs-count");
	const queue = document.getElementById("queue-count");
	const live = currentRuns().filter((r) => r.status === "running").length;
	runs.textContent = String(live);
	runs.hidden = !live;
	queue.textContent = String(app.state.queue.length);
	queue.hidden = !app.state.queue.length;
}

const ctx = {
	get state() {
		return app.state;
	},
	set state(next) {
		app.state = next;
	},
	ui,
	toast,
	updateCounts,
	pending: () => app.pending,
	reload: async () => {
		await load();
		render();
	},
	select(name) {
		slimHero();
		app.state = selectModel(app.state, name);
		setView("models");
	},
	openAdd() {
		openAddModel(ctx);
	},
	again(run) {
		app.state = { ...selectModel(app.state, run.model), form: { ...app.state.form, ...againForm(run, app.state.benchmarks), apiKey: "" } };
		setView("models");
		toast("Same setup loaded. Check it, then benchmark.");
	},
	currentItem: () => stageRun({ ...app.state, queue: [] }).queue[0],
	stage() {
		const check = stageCheck(app.state);
		if (!check.ok) return toast(check.message);
		app.state = { ...stageRun(app.state), form: { ...app.state.form, apiKey: "" } };
		render();
		toast("Added to the queue");
	},
	unstage(i) {
		app.state = removeStaged(app.state, i);
		render();
		document.getElementById("queue-h")?.focus();
	},
	confirm(items) {
		slimHero();
		app.pending = [...items];
		openConfirm(ctx, items);
	},
	/**
	 * Hands any key to the API (memory only), then starts one run per item. Each item leaves the queue the moment its
	 * run starts. Returns true when everything started; on a failure the confirmation keeps only what is left.
	 */
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
		if (started.length) ui.runSel = started.at(-1);
		await load().catch(() => {});
		if (failed) {
			toast(`${started.length ? `${started.length} started. ` : ""}${failed.model} could not start: ${error.message}`);
			render();
			return false;
		}
		setView("runs");
		return true;
	},
	/** Reloads models and runs after a run settles, without redrawing the Runs tab. */
	async refreshModels() {
		await load();
		await loadRuns().catch(() => {});
		updateCounts();
	},
};

function render() {
	if (app.view !== "runs") stopRunning();
	updateCounts();
	if (app.view === "runs") return renderRunning(ctx);
	if (app.view === "queue") return renderQueue(ctx);
	renderBenchmark(ctx);
	renderModelList(ctx);
	// The table's "Last result" needs the runs; draw it again once they are in.
	loadRuns().then(() => app.view === "models" && renderModelList(ctx), () => {}).finally(updateCounts);
}

function markNav(view) {
	for (const b of document.querySelectorAll(".nav button")) {
		if (b.dataset.view === view) b.setAttribute("aria-current", "page");
		else b.removeAttribute("aria-current");
	}
}

function setView(view) {
	if (view !== app.view) slimHero();
	app.view = view;
	markNav(view);
	render();
}

for (const b of document.querySelectorAll(".nav button")) b.addEventListener("click", () => setView(b.dataset.view));
document.getElementById("add").addEventListener("click", () => ctx.openAdd());
document.getElementById("tour").addEventListener("click", () => {
	if (app.view !== "models") setView("models");
	startTour();
});

// Open on the Runs tab when something is already running (a reload mid-run shows the same screen).
const resumeRuns = async () => {
	const runs = groupRuns(await api.jobs().catch(() => []));
	if (runs.some((r) => r.status === "running")) {
		app.view = "runs";
		slimHero();
		markNav("runs");
	}
};

setupTheme();
load()
	.then(resumeRuns)
	.then(render)
	.then(() => app.view === "models" && !hasSeenTour() && startTour())
	.catch((err) => {
		render();
		toast(err.message);
	});
