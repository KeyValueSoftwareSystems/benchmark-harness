import { h } from "../dom.js";

// Small building blocks shared by the two cards. SVG markup here only ever contains constants and numbers.

const SVG_NS = "http://www.w3.org/2000/svg";
export const ICONS = {
	setup: '<path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h5v5"/>',
	trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>',
	target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/>',
	bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/>',
	key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3"/>',
	stack: '<path d="M12 3 3 8l9 5 9-5-9-5ZM3 13l9 5 9-5"/>',
	flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
	x: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>',
	check: '<path d="m2.5 6.2 2.3 2.3 4.7-5"/>',
	list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};
export const COLORS = ["var(--accent)", "var(--green)", "var(--violet)"];

export function icon(name, cls = "", viewBox = "0 0 24 24") {
	const svg = document.createElementNS(SVG_NS, "svg");
	for (const [k, v] of Object.entries({ viewBox, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
	if (cls) svg.setAttribute("class", cls);
	svg.innerHTML = ICONS[name];
	return svg;
}

/** Card title row: icon, heading, and an optional control on the right (pills, a dropdown, a count). */
export const cardHead = (iconName, title, right, { gold = false, id } = {}) =>
	h("div", { class: "card-h" }, h("h2", { id, tabindex: id ? "-1" : false }, icon(iconName, gold ? "gold" : ""), title), right ?? null);

/** Pill group like the reference's 7D/30D switch. `options` is [[value, label], …]. */
export const seg = (options, current, onPick, label) =>
	h("div", { class: "seg", role: "group", "aria-label": label },
		options.map(([v, t]) => h("button", { type: "button", "aria-pressed": String(current === v), onclick: () => onPick(v) }, t)));

/** One stat row: label with icon, big value, small note, a mini bar for `fraction` (0..1). */
export const stat = ({ iconName, label, value, note, fraction, color, extra }) =>
	h("div", { class: "stat" },
		h("span", { class: "lbl" }, icon(iconName), label),
		h("span", { class: "val" }, value, note ? h("small", {}, note) : null),
		h("span", { class: "mini", "aria-hidden": "true" }, h("i", { style: `width:${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%;background:${color}` })),
		extra ?? null);

/** Ring gauge (the radar slot): percentage in the middle, a caption under it. */
export function gauge(fraction, color, caption, label) {
	const r = 48;
	const c = 2 * Math.PI * r;
	const f = Math.max(0, Math.min(1, fraction));
	const el = document.createElementNS(SVG_NS, "svg");
	el.setAttribute("class", "gauge");
	el.setAttribute("viewBox", "0 0 120 120");
	el.setAttribute("role", "img");
	el.setAttribute("aria-label", label);
	el.innerHTML = `<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--line)" stroke-width="10"/>
<circle cx="60" cy="60" r="${r}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/>
<text x="60" y="60" text-anchor="middle" fill="var(--text)" font-size="24" font-weight="700">${Math.round(f * 100)}%</text>`;
	const t = document.createElementNS(SVG_NS, "text");
	for (const [k, v] of Object.entries({ x: "60", y: "80", "text-anchor": "middle", fill: "var(--muted)", "font-size": "11" })) t.setAttribute(k, v);
	t.textContent = caption;
	el.append(t);
	return el;
}

const hue = (name) => [...name.split("/")[0]].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 360, 7);
/** A coloured initial for a model, tinted by provider so one provider's models match. */
export const modelIcon = (name) => h("span", { class: "mico", style: `--h:${hue(name)}`, "aria-hidden": "true" }, (name[0] ?? "?").toUpperCase());

/** "4 min ago", "3 h ago", "2 d ago". */
export function ago(iso) {
	const t = Date.parse(iso);
	if (!t) return "—";
	const m = Math.max(0, Math.round((Date.now() - t) / 60000));
	return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

/** Number of challenges an item will run, or "1 prompt". */
export function describeItem(item, benchmarks) {
	const bench = benchmarks.find((b) => b.name === item.benchmark);
	if (bench?.needsPrompt) return "1 prompt";
	const n = item.challenges === "all" ? bench?.challenges.length ?? 0 : item.challenges.length;
	return `${n} challenge${n === 1 ? "" : "s"}${item.challenges === "all" ? " (all)" : ""}`;
}
