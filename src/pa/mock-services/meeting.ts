import { Router } from "express";
import { RecordStore, type FixtureRecord } from "./record-store.ts";
import type { FixtureLoader } from "./types.ts";

const SCHEDULED = "scheduled";
const IN_PROGRESS = "in_progress";
const ENDED = "completed";
const CANCELLED = "cancelled";
const TERMINAL_STATUSES = new Set([ENDED, CANCELLED, "ended"]);

export function meetingRoutes(load: FixtureLoader): Router {
	const r = Router();
	const store = new RecordStore<FixtureRecord>(() => load("meeting/meetings.json"), ["meeting_id", "id"], "MTG");
	const meetings = (): FixtureRecord[] => store.all();

	r.post("/meeting/list", (req, res) => {
		res.json({ total: meetings().length, meetings: meetings() });
	});

	r.post("/meeting/get", (req, res) => {
		const { meeting_id } = req.body;
		if (!meeting_id) return res.json({ error: "meeting_id required" });
		const m = store.find(meeting_id);
		if (!m) return res.status(404).json({ error: "meeting not found" });
		res.json(m);
	});

	r.post("/meeting/create", (req, res) => {
		const { topic, host, start_time, duration_minutes, participants, join_url, passcode } = req.body;
		const meeting = store.create({
			topic,
			host,
			start_time,
			duration_minutes,
			participants: participants ?? [],
			join_url,
			passcode,
			status: SCHEDULED,
		});
		res.json({ success: true, meeting_id: meeting.meeting_id });
	});

	/** Changes the meeting's status when `nextStatus` returns one; terminal meetings reject every change. */
	const changeStatus = (meetingId: string, nextStatus: (current: string) => string | undefined) => {
		const meeting = store.find(meetingId);
		if (!meeting) return { status: 404, body: { success: false, error: "meeting not found" } };
		if (TERMINAL_STATUSES.has(meeting.status)) return { status: 409, body: { success: false, error: `meeting is ${meeting.status}` } };
		const status = nextStatus(meeting.status);
		if (!status) return { status: 409, body: { success: false, error: `meeting is ${meeting.status}` } };
		store.update(meetingId, { status });
		return { status: 200, body: { success: true } };
	};

	r.post("/meeting/update", (req, res) => {
		const { meeting_id, ...changes } = req.body;
		const meeting = store.find(meeting_id);
		if (!meeting) return res.status(404).json({ success: false, error: "meeting not found" });
		if (TERMINAL_STATUSES.has(meeting.status)) return res.status(409).json({ success: false, error: `meeting is ${meeting.status}` });
		store.update(meeting_id, changes);
		res.json({ success: true });
	});

	r.post("/meeting/cancel", (req, res) => {
		const outcome = changeStatus(req.body.meeting_id, () => CANCELLED);
		res.status(outcome.status).json(outcome.body);
	});

	r.post("/meeting/start", (req, res) => {
		const outcome = changeStatus(req.body.meeting_id, (current) => (current === SCHEDULED ? IN_PROGRESS : undefined));
		res.status(outcome.status).json(outcome.body);
	});

	r.post("/meeting/end", (req, res) => {
		const outcome = changeStatus(req.body.meeting_id, (current) => (current === SCHEDULED ? CANCELLED : ENDED));
		res.status(outcome.status).json(outcome.body);
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
