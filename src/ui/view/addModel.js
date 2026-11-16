import { api } from "../api.js";
import { clear, h } from "../dom.js";
import { toModelPayload, validateNewModel } from "../state.js";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const empty = () => ({ name: "", modelId: "", baseUrl: "", api: "openai-completions", apiKey: "", docsUrl: "", thinkingLevel: "off", costIn: "", costOut: "" });

/**
 * The Add-a-model drawer: a modal panel from the right, so the page stays in view behind it. The key lives only in
 * this form, and the whole dialog (with the form) is removed when it closes.
 */
export function openAddModel(ctx) {
	const host = document.getElementById("dialogs");
	const f = empty();
	let errors = {};
	let levels = LEVELS;
	let note = "";
	let focusKey = "name";

	const dialog = h("dialog", { class: "drawer", "aria-labelledby": "add-h" });
	const form = h("form", { novalidate: true, onsubmit: submit });
	dialog.append(form);

	const field = (key, label, attrs = {}, hint) => {
		const id = `f-${key}`;
		return h("div", { class: "field" },
			h("label", { for: id }, label),
			h("input", { id, name: key, autocomplete: "off", spellcheck: "false", value: f[key], "aria-invalid": errors[key] ? "true" : false, "aria-describedby": errors[key] ? `${id}-e` : false, oninput: (e) => (f[key] = e.target.value), ...attrs }),
			hint ? h("p", { class: "hint" }, hint) : null,
			errors[key] ? h("p", { class: "error", id: `${id}-e` }, errors[key]) : null);
	};

	function draw() {
		clear(form);
		form.append(
			h("div", { class: "d-h" }, h("h2", { id: "add-h" }, "Add a model"), h("button", { class: "ghost", type: "button", "aria-label": "Close", onclick: () => dialog.close() }, "✕")),
			h("div", { class: "d-b" },
				h("p", { class: "sec" }, "Connection"),
				field("name", "Model name", { required: true, placeholder: "provider/model-name" }),
				field("baseUrl", "Base URL", { required: true, placeholder: "https://api.example.com/v1" }),
				h("div", { class: "row2" }, field("api", "API type", { required: true }), field("modelId", "Provider model id", { placeholder: "optional" })),
				field("apiKey", "API key", { type: "password", required: true, autocomplete: "new-password" }, "Never stored. Held in memory until the API restarts."),
				h("p", { class: "sec" }, "Parameters"),
				ctx.state.discovery
					? h("div", { class: "field" },
						h("label", { for: "f-docsUrl" }, "Docs link"),
						h("div", { class: "inline" },
							h("input", { id: "f-docsUrl", name: "docsUrl", autocomplete: "off", value: f.docsUrl, placeholder: "https://…", oninput: (e) => (f.docsUrl = e.target.value) }),
							h("button", { class: "btn", type: "button", onclick: discover }, "Discover")),
						h("p", { class: "hint", role: "status" }, note || "Fills thinking levels and prices from the provider's page."))
					: null,
				h("div", { class: "field" },
					h("label", { for: "f-thinkingLevel" }, "Thinking level"),
					h("select", { id: "f-thinkingLevel", onchange: (e) => (f.thinkingLevel = e.target.value) }, levels.map((l) => h("option", { value: l, selected: l === f.thinkingLevel }, l)))),
				h("div", { class: "row2" }, field("costIn", "Price in, $ per M tokens", { inputmode: "decimal" }), field("costOut", "Price out, $ per M tokens", { inputmode: "decimal" })),
				errors.cost ? h("p", { class: "error" }, errors.cost) : null,
				errors.form ? h("p", { class: "error", role: "alert" }, errors.form) : null),
			h("div", { class: "d-f" }, h("button", { class: "btn", type: "button", onclick: () => dialog.close() }, "Cancel"), h("button", { class: "btn primary", type: "submit" }, "Add model")));
		form.querySelector(`#f-${focusKey}`)?.focus();
	}

	async function discover() {
		note = "Reading the page…";
		focusKey = "docsUrl";
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
		focusKey = Object.keys(errors).find((k) => k !== "cost" && k !== "form") ?? "name";
		if (!check.ok) return draw();
		try {
			await api.addModel(toModelPayload(f));
			const name = f.name.trim();
			f.apiKey = "";
			dialog.close();
			await ctx.reload();
			ctx.select(name);
			ctx.toast(`Added ${name}`);
		} catch (err) {
			errors = { form: err.status === 409 ? "A model with that name already exists." : err.message };
			draw();
		}
	}

	// Escape, the close button, Cancel or a click on the backdrop all close it; the form and its key go with it.
	dialog.addEventListener("close", () => {
		f.apiKey = "";
		dialog.remove();
		document.getElementById("add")?.focus();
	});
	dialog.addEventListener("click", (e) => {
		if (e.target === dialog) dialog.close();
	});
	host.append(dialog);
	draw();
	dialog.showModal();
	form.querySelector("#f-name")?.focus();
}
