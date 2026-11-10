import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function clawZoteroRoutes(load: FixtureLoader): Router {
	const r = Router();
	const library = (): any[] => load("claw_zotero/library.json");

	r.post("/claw_zotero/items", (req, res) => {
		res.json({ total: library().length, items: library() });
	});

	r.post("/claw_zotero/items/get", (req, res) => {
		const { item_id } = req.body;
		if (!item_id) return res.json({ error: "item_id required" });
		const item = library().find((i) => i.item_id === item_id || i.id === item_id || i.key === item_id);
		if (!item) return res.status(404).json({ error: "item not found" });
		res.json(item);
	});

	r.post("/claw_zotero/items/add", (req, res) => {
		console.log("[mock-zotero] add item:", req.body.title);
		res.json({ success: true, item_id: `ZOT-${Date.now()}` });
	});

	r.post("/claw_zotero/items/update", (req, res) => {
		console.log("[mock-zotero] update:", req.body.item_id);
		res.json({ success: true });
	});

	r.post("/claw_zotero/items/delete", (req, res) => {
		console.log("[mock-zotero] delete:", req.body.item_id);
		res.json({ success: true });
	});

	r.post("/claw_zotero/items/add_note", (req, res) => {
		console.log("[mock-zotero] add note to:", req.body.item_id);
		res.json({ success: true });
	});

	r.post("/claw_zotero/items/add_to_collection", (req, res) => {
		console.log("[mock-zotero] add to collection:", req.body.collection_id);
		res.json({ success: true });
	});

	r.post("/claw_zotero/items/remove_from_collection", (req, res) => {
		console.log("[mock-zotero] remove from collection:", req.body.collection_id);
		res.json({ success: true });
	});

	r.post("/claw_zotero/collections", (req, res) => {
		res.json({ total: 0, collections: [] });
	});

	r.post("/claw_zotero/search", (req, res) => {
		const all = library();
		const { query } = req.body;
		if (!query) return res.json({ total: all.length, results: all });
		const q = String(query).toLowerCase();
		const filtered = all.filter((i) => JSON.stringify(i).toLowerCase().includes(q));
		res.json({ total: filtered.length, results: filtered });
	});

	return r;
}
