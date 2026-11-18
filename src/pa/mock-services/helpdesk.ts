import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function helpdeskRoutes(load: FixtureLoader): Router {
	const r = Router();
	const tickets = (): any[] => load("helpdesk/tickets.json");

	r.post("/helpdesk/tickets", (req, res) => {
		const all = tickets();
		const { status = "open" } = req.body;
		const filtered =
			status === "all" ? all : all.filter((t) => t.status === status);
		res.json({ total: filtered.length, tickets: filtered });
	});

	r.post("/helpdesk/tickets/get", (req, res) => {
		const { ticket_id } = req.body;
		if (!ticket_id) return res.json({ error: "ticket_id required" });
		const t = tickets().find((t) => t.ticket_id === ticket_id);
		if (!t) return res.status(404).json({ error: "ticket not found" });
		res.json(t);
	});

	r.post("/helpdesk/tickets/update", (req, res) => {
		console.log("[mock-helpdesk] update:", req.body.ticket_id);
		res.json({ success: true });
	});

	r.post("/helpdesk/tickets/close", (req, res) => {
		console.log("[mock-helpdesk] close:", req.body.ticket_id);
		res.json({ success: true });
	});

	return r;
}
