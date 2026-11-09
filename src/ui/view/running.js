import { clear, h } from "../dom.js";

/** Placeholder until the running view lands in the next task. */
export function renderRunning() {
	const root = document.getElementById("stage");
	clear(root);
	root.append(h("p", { class: "empty" }, "Run started."));
}
