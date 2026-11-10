import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function clawNotionRoutes(load: FixtureLoader): Router {
	const r = Router();
	const pages = (): any[] => load("claw_notion/pages.json");

	r.post("/claw_notion/pages", (req, res) => {
		res.json({ total: pages().length, pages: pages() });
	});

	r.post("/claw_notion/pages/get", (req, res) => {
		const { page_id } = req.body;
		if (!page_id) return res.json({ error: "page_id required" });
		const p = pages().find((p) => p.page_id === page_id || p.id === page_id);
		if (!p) return res.status(404).json({ error: "page not found" });
		res.json(p);
	});

	r.post("/claw_notion/pages/create", (req, res) => {
		console.log("[mock-notion] create page:", req.body.title);
		res.json({ success: true, page_id: `PAGE-${Date.now()}` });
	});

	r.post("/claw_notion/pages/update_properties", (req, res) => {
		console.log("[mock-notion] update properties:", req.body.page_id);
		res.json({ success: true });
	});

	r.post("/claw_notion/pages/archive", (req, res) => {
		console.log("[mock-notion] archive:", req.body.page_id);
		res.json({ success: true });
	});

	r.post("/claw_notion/pages/append_blocks", (req, res) => {
		console.log("[mock-notion] append blocks:", req.body.page_id);
		res.json({ success: true });
	});

	r.post("/claw_notion/database/query", (req, res) => {
		res.json({ total: pages().length, results: pages() });
	});

	r.post("/claw_notion/search", (req, res) => {
		const all = pages();
		const { query } = req.body;
		if (!query) return res.json({ total: all.length, results: all });
		const q = String(query).toLowerCase();
		const filtered = all.filter(
			(p) =>
				JSON.stringify(p).toLowerCase().includes(q),
		);
		res.json({ total: filtered.length, results: filtered });
	});

	return r;
}
