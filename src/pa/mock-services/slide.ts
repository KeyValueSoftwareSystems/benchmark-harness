import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function slideRoutes(load: FixtureLoader): Router {
	const r = Router();
	const decks = (): any[] => load("slide/decks.json");

	r.post("/slide/decks", (req, res) => {
		res.json({ total: decks().length, decks: decks() });
	});

	r.post("/slide/open", (req, res) => {
		const { deck_id } = req.body;
		if (!deck_id) return res.json({ error: "deck_id required" });
		const d = decks().find((d) => d.deck_id === deck_id || d.id === deck_id);
		if (!d) return res.status(404).json({ error: "deck not found" });
		res.json(d);
	});

	r.post("/slide/create_deck", (req, res) => {
		console.log("[mock-slide] create deck:", req.body.name);
		res.json({ success: true, deck_id: `DECK-${Date.now()}` });
	});

	r.post("/slide/delete_deck", (req, res) => {
		console.log("[mock-slide] delete deck:", req.body.deck_id);
		res.json({ success: true });
	});

	r.post("/slide/add_slide", (req, res) => {
		console.log("[mock-slide] add slide");
		res.json({ success: true, slide_id: `SLIDE-${Date.now()}` });
	});

	r.post("/slide/get_slide", (req, res) => {
		const { slide_id } = req.body;
		if (!slide_id) return res.json({ error: "slide_id required" });
		res.json({ slide_id, content: "", elements: [] });
	});

	r.post("/slide/delete_slide", (req, res) => {
		console.log("[mock-slide] delete slide:", req.body.slide_id);
		res.json({ success: true });
	});

	r.post("/slide/duplicate_slide", (req, res) => {
		console.log("[mock-slide] duplicate:", req.body.slide_id);
		res.json({ success: true, slide_id: `SLIDE-DUP-${Date.now()}` });
	});

	r.post("/slide/reorder_slide", (req, res) => {
		console.log("[mock-slide] reorder");
		res.json({ success: true });
	});

	r.post("/slide/set_slide_content", (req, res) => {
		console.log("[mock-slide] set content:", req.body.slide_id);
		res.json({ success: true });
	});

	r.post("/slide/add_element", (req, res) => {
		console.log("[mock-slide] add element");
		res.json({ success: true, element_id: `ELEM-${Date.now()}` });
	});

	r.post("/slide/update_element", (req, res) => {
		console.log("[mock-slide] update element:", req.body.element_id);
		res.json({ success: true });
	});

	return r;
}
