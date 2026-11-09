/**
 * Builds an element. Children are text nodes or elements, never HTML, so a model name like `<img onerror=…>`
 * is shown as text everywhere. `on*` attributes are event listeners.
 */
export function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs ?? {})) {
		if (v === false || v === null || v === undefined) continue;
		if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
		else if (k === "class") el.className = v;
		else el.setAttribute(k, v === true ? "" : String(v));
	}
	for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
	return el;
}
/** Appends elements, skipping empty slots: a bare `el.append(null)` would add the text "null". */
export const put = (el, ...children) => el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
export const clear = (el) => el.replaceChildren();
