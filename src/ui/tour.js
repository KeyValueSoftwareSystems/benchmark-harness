import { clear, h } from "./dom.js";

export const TOUR_COOKIE = "smithy-tour";

export const TOUR_STEPS = [
	{ target: ".add", title: "Start here", text: "Add a model with its name, base URL and API key. The key is never stored: it stays in memory until the API restarts." },
	{ target: "#list", title: "Your models", text: "Models are grouped by the benchmark they have run on. Click one to select it." },
	{ target: "#stage", title: "Set up a run", text: "The selected model sits here. Pick the benchmark and challenges, then Benchmark now or Add to queue. You confirm before anything spends credits." },
	{ target: "#queue", title: "The queue", text: "Queued items wait here. Press the info button on an item to see exactly what it will run. The same setup can't be queued twice." },
	{ target: "#runs", title: "Runs and reports", text: "Watch progress here, cancel a run, generate a report, or benchmark again." },
];

/** The only cookie the page sets: whether the intro has been seen. It holds no personal data. */
export const tourDone = (cookie) => cookie.split(";").some((part) => part.trim() === `${TOUR_COOKIE}=done`);
export const tourDoneCookie = () => `${TOUR_COOKIE}=done; max-age=31536000; path=/; SameSite=Lax`;

let active = null;

export function hasSeenTour() {
	try {
		return tourDone(document.cookie);
	} catch {
		return true;
	}
}
const markSeen = () => {
	try {
		document.cookie = tourDoneCookie();
	} catch {}
};

/** A step-by-step intro: a card next to each part of the page, with Back, Next and Skip. Finishing or skipping saves the cookie. */
export function startTour() {
	if (active) return;
	let i = 0;
	const opener = document.activeElement;
	const card = h("div", { class: "tour", role: "dialog", "aria-modal": "false", "aria-labelledby": "tour-t", "aria-describedby": "tour-d" });
	document.body.append(card);
	let marked = null;

	const place = () => {
		const el = document.querySelector(TOUR_STEPS[i].target);
		if (!el) return;
		const r = el.getBoundingClientRect();
		const w = Math.min(340, innerWidth - 32);
		card.style.width = `${w}px`;
		if (innerWidth <= 700) {
			card.style.left = "16px";
			card.style.top = "auto";
			card.style.bottom = "16px";
			return;
		}
		card.style.bottom = "auto";
		const below = r.bottom + 12 + 200 < innerHeight;
		card.style.top = `${Math.max(12, below ? r.bottom + 12 : Math.max(12, r.top - 12 - card.offsetHeight))}px`;
		card.style.left = `${Math.min(Math.max(12, r.left), innerWidth - w - 12)}px`;
	};

	const show = () => {
		const step = TOUR_STEPS[i];
		const el = document.querySelector(step.target);
		marked?.classList.remove("tour-target");
		marked = el;
		el?.classList.add("tour-target");
		el?.scrollIntoView({ block: "nearest" });
		clear(card);
		card.append(
			h("p", { class: "hint" }, `Step ${i + 1} of ${TOUR_STEPS.length}`),
			h("h3", { id: "tour-t" }, step.title),
			h("p", { id: "tour-d" }, step.text),
			h("div", { class: "tour-actions" },
				h("button", { class: "btn", type: "button", onclick: finish }, "Skip"),
				i > 0 ? h("button", { class: "btn", type: "button", onclick: () => ((i -= 1), show()) }, "Back") : null,
				h("button", { class: "btn primary", type: "button", id: "tour-next", onclick: () => (i === TOUR_STEPS.length - 1 ? finish() : ((i += 1), show())) }, i === TOUR_STEPS.length - 1 ? "Done" : "Next")));
		place();
		card.querySelector("#tour-next")?.focus();
	};

	const onKey = (e) => {
		// An open dialog (the challenge picker) takes the Escape; the tour waits.
		if (e.key === "Escape" && !document.querySelector("dialog[open]")) finish();
	};
	function finish() {
		markSeen();
		marked?.classList.remove("tour-target");
		card.remove();
		document.removeEventListener("keydown", onKey);
		removeEventListener("resize", place);
		active = null;
		opener?.focus?.();
	}

	active = finish;
	document.addEventListener("keydown", onKey);
	addEventListener("resize", place);
	show();
}
