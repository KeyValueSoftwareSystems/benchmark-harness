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
export const clear = (el) => el.replaceChildren();
