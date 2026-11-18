import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function contactsRoutes(load: FixtureLoader): Router {
	const r = Router();
	const contacts = (): any[] => load("contacts/contacts.json");

	r.post("/contacts/search", (req, res) => {
		const all = contacts();
		const { name, department } = req.body;
		let filtered = all;
		if (name) {
			const q = String(name).toLowerCase();
			filtered = filtered.filter((c) => c.name.toLowerCase().includes(q));
		}
		if (department) {
			const q = String(department).toLowerCase();
			filtered = filtered.filter(
				(c) => c.department && c.department.toLowerCase().includes(q),
			);
		}
		res.json({ total: filtered.length, contacts: filtered });
	});

	r.post("/contacts/get", (req, res) => {
		const { contact_id } = req.body;
		if (!contact_id) return res.json({ error: "contact_id required" });
		const c = contacts().find((c) => c.contact_id === contact_id);
		if (!c) return res.status(404).json({ error: "contact not found" });
		res.json(c);
	});

	r.post("/contacts/send_message", (req, res) => {
		console.log("[mock-contacts] message to:", req.body.contact_id);
		res.json({ success: true });
	});

	return r;
}
