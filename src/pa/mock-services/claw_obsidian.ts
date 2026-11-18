import { Router } from "express";
import { RecordStore, type FixtureRecord } from "./record-store.ts";
import type { FixtureLoader } from "./types.ts";

export function clawObsidianRoutes(load: FixtureLoader): Router {
	const r = Router();
	const store = new RecordStore<FixtureRecord>(() => load("claw_obsidian/vault.json"), ["note_id", "id", "path"], "OBSN");
	const vault = (): FixtureRecord[] => store.all();

	r.post("/claw_obsidian/notes", (req, res) => {
		res.json({ total: vault().length, notes: vault() });
	});

	r.post("/claw_obsidian/notes/get", (req, res) => {
		const { note_id } = req.body;
		if (!note_id) return res.json({ error: "note_id required" });
		const n = store.find(note_id);
		if (!n) return res.status(404).json({ error: "note not found" });
		res.json(n);
	});

	r.post("/claw_obsidian/notes/create", (req, res) => {
		const { title, folder, tags, content } = req.body;
		const note = store.create({ title, folder: folder ?? "", tags: tags ?? [], content: content ?? "" });
		res.json({ success: true, note_id: note.note_id });
	});

	r.post("/claw_obsidian/notes/update", (req, res) => {
		const { note_id, ...changes } = req.body;
		if (!store.update(note_id, changes)) return res.status(404).json({ success: false, error: "note not found" });
		res.json({ success: true });
	});

	r.post("/claw_obsidian/notes/delete", (req, res) => {
		if (!store.remove(req.body.note_id)) return res.status(404).json({ success: false, error: "note not found" });
		res.json({ success: true });
	});

	r.post("/claw_obsidian/notes/append", (req, res) => {
		const { note_id, text } = req.body;
		const note = store.find(note_id);
		if (!note) return res.status(404).json({ success: false, error: "note not found" });
		store.update(note_id, { content: `${note.content ?? ""}\n${text}` });
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
