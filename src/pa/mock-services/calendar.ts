import { Router } from "express";
import { RecordStore } from "./record-store.ts";
import type { FixtureLoader } from "./types.ts";

interface CalendarEvent {
	event_id: string;
	title: string;
	start_time: string;
	end_time: string;
	attendees: string[];
	location: string;
	recurring: boolean;
}

export function calendarRoutes(load: FixtureLoader): Router {
	const r = Router();
	const store = new RecordStore<CalendarEvent>(() => load("calendar/events.json"), ["event_id"], "EVT");
	const events = (): CalendarEvent[] => store.all();

	r.post("/calendar/events", (req, res) => {
		const all = events();
		const { start_date, days = 7 } = req.body;
		let filtered = all;

		if (start_date) {
			const from = new Date(start_date);
			const to = new Date(from.getTime() + Number(days) * 86_400_000);
			filtered = all.filter((e) => {
				const d = new Date(e.start_time);
				return d >= from && d <= to;
			});
		}

		res.json({ total: filtered.length, events: filtered });
	});

	r.post("/calendar/events/get", (req, res) => {
		const { event_id } = req.body;
		if (!event_id) return res.json({ error: "event_id required" });
		const ev = events().find((e) => e.event_id === event_id);
		if (!ev) return res.status(404).json({ error: "event not found" });
		res.json(ev);
	});

	r.post("/calendar/user_events", (req, res) => {
		const { user, date } = req.body;
		const all = events();
		const dayStr = date ? String(date).slice(0, 10) : "";
		const filtered = all.filter((e) => {
			const matchDate = !dayStr || e.start_time.startsWith(dayStr);
			const matchUser =
				!user ||
				e.attendees.some((a: string) =>
					a.toLowerCase().includes(String(user).toLowerCase()),
				);
			return matchDate && matchUser;
		});
		res.json({ total: filtered.length, events: filtered });
	});

	r.post("/calendar/events/create", (req, res) => {
		const { title, start_time, end_time, attendees, location } = req.body;
		const event = store.create({
			title,
			start_time,
			end_time,
			attendees: attendees ?? [],
			location: location ?? "",
			recurring: false,
		});
		res.json({ success: true, event_id: event.event_id });
	});

	r.post("/calendar/events/delete", (req, res) => {
		if (!store.remove(req.body.event_id)) return res.status(404).json({ success: false, error: "event not found" });
		res.json({ success: true });
	});

	return r;
}
