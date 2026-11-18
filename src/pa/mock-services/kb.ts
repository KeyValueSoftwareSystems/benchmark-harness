import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function kbRoutes(load: FixtureLoader): Router {
	const r = Router();
	const articles = (): any[] => load("kb/articles.json");

	r.post("/kb/search", (req, res) => {
		const all = articles();
		const { query, offset = 0, limit = 5 } = req.body;
		let filtered = all;

		if (query) {
			const q = String(query).toLowerCase();
			filtered = all.filter(
				(a) =>
					a.title.toLowerCase().includes(q) ||
					(a.content && a.content.toLowerCase().includes(q)) ||
					(a.tags || []).some((t: string) => t.toLowerCase().includes(q)),
			);
		}

		const page = filtered.slice(Number(offset), Number(offset) + Number(limit));
		res.json({
			total: filtered.length,
			returned: page.length,
			articles: page.map((a) => ({
				article_id: a.article_id,
				title: a.title,
				category: a.category,
				snippet: a.content ? a.content.slice(0, 150) : "",
			})),
		});
	});

	r.post("/kb/articles/get", (req, res) => {
		const { article_id } = req.body;
		if (!article_id) return res.json({ error: "article_id required" });
		const a = articles().find((a) => a.article_id === article_id);
		if (!a) return res.status(404).json({ error: "article not found" });
		res.json(a);
	});

	r.post("/kb/articles/update", (req, res) => {
		console.log("[mock-kb] update:", req.body.article_id);
		res.json({ success: true });
	});

	return r;
}
