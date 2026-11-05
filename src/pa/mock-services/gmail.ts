import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

interface Message {
	message_id: string;
	from: string;
	to: string;
	subject: string;
	date: string;
	body: string;
	labels: string[];
	is_read: boolean;
}

export function gmailRoutes(load: FixtureLoader): Router {
	const r = Router();
	const messages = (): Message[] => load("gmail/inbox.json");

	r.post("/gmail/messages", (req, res) => {
		const all = messages();
		const { query, offset = 0, limit = 20 } = req.body;
		let filtered = all;

		if (query) {
			const words = String(query).toLowerCase().split(/\s+/);
			filtered = all.filter((m) =>
				words.every(
					(w) =>
						m.subject.toLowerCase().includes(w) ||
						m.from.toLowerCase().includes(w),
				),
			);
		}

		const page = filtered.slice(Number(offset), Number(offset) + Number(limit));
		res.json({
			total: filtered.length,
			returned: page.length,
			messages: page.map(({ body: _, ...rest }) => rest),
		});
	});

	r.post("/gmail/messages/get", (req, res) => {
		const { message_id } = req.body;
		if (!message_id) return res.json({ error: "message_id required" });
		const msg = messages().find((m) => m.message_id === message_id);
		if (!msg) return res.status(404).json({ error: "message not found" });
		res.json(msg);
	});

	r.post("/gmail/send", (req, res) => {
		console.log("[mock-gmail] send:", req.body.to, req.body.subject);
		res.json({ success: true, message_id: `MSG-SENT-${Date.now()}` });
	});

	r.post("/gmail/drafts/save", (req, res) => {
		console.log("[mock-gmail] draft saved:", req.body.subject);
		res.json({ success: true, draft_id: `DRAFT-${Date.now()}` });
	});

	return r;
}
