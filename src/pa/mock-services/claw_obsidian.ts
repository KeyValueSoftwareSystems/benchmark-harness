import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function clawObsidianRoutes(load: FixtureLoader): Router {
	const r = Router();
	const vault = (): any[] => load("claw_obsidian/vault.json");

	r.post("/claw_obsidian/notes", (req, res) => {
		res.json({ total: vault().length, notes: vault() });
	});

	r.post("/claw_obsidian/notes/get", (req, res) => {
		const { note_id } = req.body;
		if (!note_id) return res.json({ error: "note_id required" });
		const n = vault().find((n) => n.note_id === note_id || n.id === note_id || n.path === note_id);
		if (!n) return res.status(404).json({ error: "note not found" });
		res.json(n);
	});

	r.post("/claw_obsidian/notes/create", (req, res) => {
		console.log("[mock-obsidian] create:", req.body.title);
		res.json({ success: true, note_id: `OBS-${Date.now()}` });
	});

	r.post("/claw_obsidian/notes/update", (req, res) => {
		console.log("[mock-obsidian] update:", req.body.note_id);
		res.json({ success: true });
	});

	r.post("/claw_obsidian/notes/delete", (req, res) => {
		console.log("[mock-obsidian] delete:", req.body.note_id);
		res.json({ success: true });
	});

	r.post("/claw_obsidian/notes/append", (req, res) => {
		console.log("[mock-obsidian] append:", req.body.note_id);
		res.json({ success: true });
	});

	r.post("/claw_obsidian/search", (req, res) => {
		const all = vault();
		const { query } = req.body;
		if (!query) return res.json({ total: all.length, results: all });
		const q = String(query).toLowerCase();
		const filtered = all.filter((n) => JSON.stringify(n).toLowerCase().includes(q));
		res.json({ total: filtered.length, results: filtered });
	});

	r.post("/claw_obsidian/backlinks", (req, res) => {
		const { note_id } = req.body;
		if (!note_id) return res.json({ error: "note_id required" });
		res.json({ total: 0, backlinks: [] });
	});

	r.post("/claw_obsidian/links/add", (req, res) => {
		console.log("[mock-obsidian] add link:", req.body.from, "→", req.body.to);
		res.json({ success: true });
	});

	r.post("/claw_obsidian/links/remove", (req, res) => {
		console.log("[mock-obsidian] remove link:", req.body.from, "→", req.body.to);
		res.json({ success: true });
	});

	return r;
}
