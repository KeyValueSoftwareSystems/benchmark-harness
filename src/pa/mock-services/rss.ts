import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function rssRoutes(load: FixtureLoader): Router {
	const r = Router();
	const articles = (): any[] => load("rss/articles.json");

	r.post("/rss/feeds", (req, res) => {
		const all = articles();
		const { category } = req.body;
		const sources = [
			...new Set(all.map((a) => a.source).filter(Boolean)),
		];
		const feeds = sources.map((s) => ({
			source: s,
			category: all.find((a) => a.source === s)?.category ?? "",
		}));
		const filtered = category
			? feeds.filter((f) => f.category === category)
			: feeds;
		res.json({ total: filtered.length, feeds: filtered });
	});

	r.post("/rss/articles", (req, res) => {
		const all = articles();
		const { source, category, offset = 0, limit = 20 } = req.body;
		let filtered = all;
		if (source) filtered = filtered.filter((a) => a.source === source);
		if (category) filtered = filtered.filter((a) => a.category === category);
		const page = filtered.slice(Number(offset), Number(offset) + Number(limit));
		res.json({
			total: filtered.length,
			returned: page.length,
			articles: page.map(({ content: _, ...rest }) => rest),
		});
	});

	r.post("/rss/articles/get", (req, res) => {
		const { article_id } = req.body;
		if (!article_id) return res.json({ error: "article_id required" });
		const a = articles().find((a) => a.article_id === article_id);
		if (!a) return res.status(404).json({ error: "article not found" });
		res.json(a);
	});

	r.post("/rss/publish", (req, res) => {
		console.log("[mock-rss] publish:", req.body.title);
		res.json({ success: true });
	});

	return r;
}
