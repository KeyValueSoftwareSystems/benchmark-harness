import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function notesRoutes(load: FixtureLoader): Router {
	const r = Router();
	const notes = (): any[] => load("notes/notes.json");

	r.post("/notes/list", (req, res) => {
		const all = notes();
		const { query, offset = 0, limit = 10 } = req.body;
		let filtered = all;

		if (query) {
			const words = String(query).toLowerCase().split(/\s+/);
			filtered = all.filter((n) =>
				words.every(
					(w) =>
						n.title.toLowerCase().includes(w) ||
						(n.participants || []).some((p: string) =>
							p.toLowerCase().includes(w),
						),
				),
			);
		}

		const page = filtered.slice(Number(offset), Number(offset) + Number(limit));
		res.json({
			total: filtered.length,
			returned: page.length,
			notes: page.map(({ content: _, ...rest }) => rest),
		});
	});

	r.post("/notes/get", (req, res) => {
		const { note_id } = req.body;
		if (!note_id) return res.json({ error: "note_id required" });
		const n = notes().find((n) => n.note_id === note_id);
		if (!n) return res.status(404).json({ error: "note not found" });
		res.json(n);
	});

	return r;
}
