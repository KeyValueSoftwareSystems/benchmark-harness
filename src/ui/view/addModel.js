import { api } from "../api.js";
import { clear, h } from "../dom.js";
import { toModelPayload, validateNewModel } from "../state.js";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const empty = () => ({ name: "", modelId: "", baseUrl: "", api: "openai-completions", apiKey: "", docsUrl: "", thinkingLevel: "off", costIn: "", costOut: "" });

/** The Add-a-model card. The key lives only in this form, and the form is dropped when the card closes. */
export function renderAddModel(ctx) {
	const root = document.getElementById("stage");
	clear(root);
	const f = empty();
	let errors = {};
	let levels = LEVELS;
	let note = "";

	const field = (key, label, attrs = {}, hint) => {
		const id = `f-${key}`;
		return h("div", { class: "field" },
			h("label", { for: id }, label),
			h("input", { id, name: key, autocomplete: "off", spellcheck: "false", "aria-invalid": errors[key] ? "true" : false, "aria-describedby": errors[key] ? `${id}-e` : false, oninput: (e) => (f[key] = e.target.value), ...attrs }),
			hint ? h("p", { class: "hint" }, hint) : null,
			errors[key] ? h("p", { class: "error", id: `${id}-e` }, errors[key]) : null);
	};

	const draw = () => {
		clear(root);
		root.append(
			h("form", { class: "card", novalidate: true, onsubmit: submit },
				h("h3", {}, "Add a new model"),
				field("name", "Model name", { value: f.name, required: true, placeholder: "provider/model-name" }),
				field("modelId", "Provider model id (optional)", { value: f.modelId, placeholder: "defaults to the model name" }),
				field("baseUrl", "Base URL", { value: f.baseUrl, required: true, placeholder: "https://api.example.com/v1" }),
				field("api", "API type", { value: f.api, required: true }),
				field("apiKey", "API key", { type: "password", value: f.apiKey, required: true, autocomplete: "new-password" }, "Never stored. Held in memory until the API restarts."),
				ctx.state.discovery
					? h("div", { class: "discover" },
						field("docsUrl", "Docs link (used to discover parameters)", { value: f.docsUrl, placeholder: "https://…" }),
						h("button", { class: "btn", type: "button", onclick: discover }, "Discover parameters"),
						note ? h("p", { class: "hint", role: "status" }, note) : null)
					: null,
				h("div", { class: "field" },
					h("label", { for: "f-thinkingLevel" }, "Thinking level"),
					h("select", { id: "f-thinkingLevel", onchange: (e) => (f.thinkingLevel = e.target.value) }, levels.map((l) => h("option", { value: l, selected: l === f.thinkingLevel }, l)))),
				h("div", { class: "row2" }, field("costIn", "Price in, USD per M tokens", { value: f.costIn, inputmode: "decimal" }), field("costOut", "Price out, USD per M tokens", { value: f.costOut, inputmode: "decimal" })),
				errors.cost ? h("p", { class: "error" }, errors.cost) : null,
				errors.form ? h("p", { class: "error", role: "alert" }, errors.form) : null,
				h("div", { class: "row2" }, h("button", { class: "btn", type: "button", onclick: () => ctx.closeAdd() }, "Cancel"), h("button", { class: "btn primary", type: "submit" }, "Add model"))));
	};

	async function discover() {
		note = "Reading the page…";
		draw();
		try {
			const found = await api.discover(f.docsUrl);
			if (found.thinkingLevels?.length) {
				levels = LEVELS.filter((l) => found.thinkingLevels.includes(l));
				if (!levels.includes(f.thinkingLevel)) f.thinkingLevel = levels[0];
			}
			if (found.cost) [f.costIn, f.costOut] = [String(found.cost.input), String(found.cost.output)];
			note = found.thinkingLevels?.length || found.cost ? "Found these values. Check them before adding." : "Nothing usable found on that page. Fill the fields by hand.";
		} catch (err) {
			note = err.message;
		}
		draw();
	}

	async function submit(e) {
		e.preventDefault();
		const check = validateNewModel(f);
		errors = check.errors;
		if (!check.ok) return draw();
		try {
			await api.addModel(toModelPayload(f));
			f.apiKey = "";
			await ctx.reload();
			ctx.closeAdd(f.name.trim());
			ctx.toast(`Added ${f.name.trim()}`);
		} catch (err) {
			errors = { form: err.status === 409 ? "A model with that name already exists." : err.message };
			draw();
		}
	}

	draw();
}
