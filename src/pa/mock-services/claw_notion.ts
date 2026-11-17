import { Router } from "express";
import { RecordStore, type FixtureRecord } from "./record-store.ts";
import type { FixtureLoader } from "./types.ts";

export function clawNotionRoutes(load: FixtureLoader): Router {
	const r = Router();
	const store = new RecordStore<FixtureRecord>(() => load("claw_notion/pages.json"), ["page_id", "id"], "PAGE");
	const pages = (): FixtureRecord[] => store.all().filter((page) => !page.archived);

	r.post("/claw_notion/pages", (req, res) => {
		res.json({ total: pages().length, pages: pages() });
	});

	r.post("/claw_notion/pages/get", (req, res) => {
		const { page_id } = req.body;
		if (!page_id) return res.json({ error: "page_id required" });
		const p = store.find(page_id);
		if (!p) return res.status(404).json({ error: "page not found" });
		res.json(p);
	});

	r.post("/claw_notion/pages/create", (req, res) => {
		const { title, parent_page_id, database_id, properties, blocks } = req.body;
		const page = store.create({
			title,
			parent_page_id: parent_page_id ?? null,
			database_id: database_id ?? null,
			properties: properties ?? {},
			blocks: blocks ?? [],
		});
		res.json({ success: true, page_id: page.page_id });
	});

	r.post("/claw_notion/pages/update_properties", (req, res) => {
		const { page_id, properties } = req.body;
		const page = store.find(page_id);
		if (!page) return res.status(404).json({ success: false, error: "page not found" });
		store.update(page_id, { properties: { ...page.properties, ...properties } });
		res.json({ success: true });
	});

	r.post("/claw_notion/pages/archive", (req, res) => {
		if (!store.update(req.body.page_id, { archived: true })) return res.status(404).json({ success: false, error: "page not found" });
		res.json({ success: true });
	});

	r.post("/claw_notion/pages/append_blocks", (req, res) => {
		const { page_id, blocks } = req.body;
		const page = store.find(page_id);
		if (!page) return res.status(404).json({ success: false, error: "page not found" });
		store.update(page_id, { blocks: [...(page.blocks ?? []), ...(blocks ?? [])] });
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
