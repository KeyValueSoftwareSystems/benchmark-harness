import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function meetingRoutes(load: FixtureLoader): Router {
	const r = Router();
	const meetings = (): any[] => load("meeting/meetings.json");

	r.post("/meeting/list", (req, res) => {
		res.json({ total: meetings().length, meetings: meetings() });
	});

	r.post("/meeting/get", (req, res) => {
		const { meeting_id } = req.body;
		if (!meeting_id) return res.json({ error: "meeting_id required" });
		const m = meetings().find((m) => m.meeting_id === meeting_id || m.id === meeting_id);
		if (!m) return res.status(404).json({ error: "meeting not found" });
		res.json(m);
	});

	r.post("/meeting/create", (req, res) => {
		console.log("[mock-meeting] create:", req.body.title);
		res.json({ success: true, meeting_id: `MTG-${Date.now()}` });
	});

	r.post("/meeting/update", (req, res) => {
		console.log("[mock-meeting] update:", req.body.meeting_id);
		res.json({ success: true });
	});

	r.post("/meeting/cancel", (req, res) => {
		console.log("[mock-meeting] cancel:", req.body.meeting_id);
		res.json({ success: true });
	});

	r.post("/meeting/start", (req, res) => {
		console.log("[mock-meeting] start:", req.body.meeting_id);
		res.json({ success: true });
	});

	r.post("/meeting/end", (req, res) => {
		console.log("[mock-meeting] end:", req.body.meeting_id);
		res.json({ success: true });
	});

	r.post("/meeting/participants/add", (req, res) => {
		console.log("[mock-meeting] add participant:", req.body.meeting_id);
		res.json({ success: true });
	});

	r.post("/meeting/participants/remove", (req, res) => {
		console.log("[mock-meeting] remove participant:", req.body.meeting_id);
		res.json({ success: true });
	});

	r.post("/meeting/recordings", (req, res) => {
		const { meeting_id } = req.body;
		if (!meeting_id) return res.json({ error: "meeting_id required" });
		res.json({ total: 0, recordings: [] });
	});

	return r;
}
