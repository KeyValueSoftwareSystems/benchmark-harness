import { clear, h } from "../dom.js";
import { canStart } from "../state.js";
import { createChallengePicker } from "./challengePicker.js";

/** Centre column: the chosen model drawn large, then the Benchmark section and its two buttons. */
export function renderBenchmark(ctx) {
	const root = document.getElementById("stage");
	clear(root);
	const s = ctx.state;
	const model = s.models.find((m) => m.name === s.selected);
	if (!model) return void root.append(h("p", { class: "empty" }, "Choose a model on the left, or add a new one."));
	const bench = () => s.benchmarks.find((b) => b.name === s.form.benchmark);

	const hint = h("p", { class: "hint", role: "status" });
	const now = h("button", { class: "btn primary", type: "button", onclick: () => ctx.confirm([ctx.currentItem()]) }, "Benchmark now");
	const queue = h("button", { class: "btn primary", type: "button", onclick: () => ctx.stage() }, "Add to queue");
	const refresh = () => {
		const { ok, missing } = canStart(ctx.state);
		now.disabled = queue.disabled = !ok;
		hint.textContent = ok ? "Ready." : `Still needed: ${missing.join(", ")}.`;
	};
	const set = (patch) => {
		ctx.state.form = { ...ctx.state.form, ...patch };
		refresh();
	};

	const challenges = h("div", { class: "field" });
	const drawChallenges = () => {
		clear(challenges);
		const b = bench();
		if (!b || b.needsPrompt) return;
		challenges.append(createChallengePicker({ list: b.challenges, getValue: () => ctx.state.form.challenges, onChange: (next) => set({ challenges: next }) }));
	};

	const prompt = h("div", { class: "field" });
	const drawPrompt = () => {
		clear(prompt);
		if (!bench()?.needsPrompt) return;
		prompt.append(h("label", { for: "f-prompt" }, "Prompt"), h("textarea", { id: "f-prompt", rows: "4", oninput: (e) => set({ prompt: e.target.value }) }, ctx.state.form.prompt));
	};

	root.append(
		h("div", { class: "orb", "aria-label": `Selected model ${model.name}` }, model.name.split("/").flatMap((part, i, all) => (i < all.length - 1 ? [part, "/", document.createElement("wbr")] : [part]))),
		h("div", { class: "card" },
			h("h3", {}, "Benchmark"),
			h("div", { class: "field" },
				h("label", { for: "f-bench" }, "Benchmark"),
				h("select", { id: "f-bench", onchange: (e) => (set({ benchmark: e.target.value, challenges: "all", prompt: "" }), drawChallenges(), drawPrompt()) },
					s.benchmarks.map((b) => h("option", { value: b.name, selected: b.name === s.form.benchmark }, b.name)))),
			challenges,
			prompt,
			model.needsKey
				? h("div", { class: "field" }, h("label", { for: "f-key" }, "API key"), h("input", { id: "f-key", type: "password", autocomplete: "new-password", value: s.form.apiKey, oninput: (e) => set({ apiKey: e.target.value }) }), h("p", { class: "hint" }, "Never stored. Held in memory until the API restarts."))
				: null,
			hint,
			h("div", { class: "row2" }, now, queue)));
	drawChallenges();
	drawPrompt();
	refresh();
}
