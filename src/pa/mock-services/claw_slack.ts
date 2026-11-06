import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function clawSlackRoutes(load: FixtureLoader): Router {
	const r = Router();
	const workspace = (): any => {
		const data = load("claw_slack/workspace.json");
		return Array.isArray(data) ? { channels: data } : data;
	};

	r.post("/claw_slack/channels", (req, res) => {
		const channels = workspace().channels || [];
		res.json({ total: channels.length, channels });
	});

	r.post("/claw_slack/channels/get", (req, res) => {
		const { channel_id } = req.body;
		if (!channel_id) return res.json({ error: "channel_id required" });
		const channels = workspace().channels || [];
		const ch = channels.find((c: any) => c.channel_id === channel_id || c.id === channel_id || c.name === channel_id);
		if (!ch) return res.status(404).json({ error: "channel not found" });
		res.json(ch);
	});

	r.post("/claw_slack/messages/list", (req, res) => {
		const { channel_id } = req.body;
		const channels = workspace().channels || [];
		const ch = channels.find((c: any) => c.channel_id === channel_id || c.id === channel_id);
		const messages = ch?.messages || [];
		res.json({ total: messages.length, messages });
	});

	r.post("/claw_slack/messages/search", (req, res) => {
		const { query } = req.body;
		const channels = workspace().channels || [];
		const allMessages: any[] = [];
		for (const ch of channels) {
			for (const m of ch.messages || []) {
				allMessages.push({ ...m, channel: ch.name || ch.channel_id });
			}
		}
		if (!query) return res.json({ total: allMessages.length, messages: allMessages });
		const q = String(query).toLowerCase();
		const filtered = allMessages.filter((m) => JSON.stringify(m).toLowerCase().includes(q));
		res.json({ total: filtered.length, messages: filtered });
	});

	r.post("/claw_slack/messages/thread", (req, res) => {
		const { channel_id, thread_ts } = req.body;
		if (!channel_id || !thread_ts) return res.json({ error: "channel_id and thread_ts required" });
		res.json({ total: 0, messages: [] });
	});

	r.post("/claw_slack/messages/post", (req, res) => {
		console.log("[mock-slack] post:", req.body.channel_id, req.body.text);
		res.json({ success: true, ts: String(Date.now()) });
	});

	r.post("/claw_slack/pins/add", (req, res) => {
		console.log("[mock-slack] pin:", req.body.channel_id, req.body.ts);
		res.json({ success: true });
	});

	r.post("/claw_slack/pins/remove", (req, res) => {
		console.log("[mock-slack] unpin:", req.body.channel_id, req.body.ts);
		res.json({ success: true });
	});

	r.post("/claw_slack/reactions/add", (req, res) => {
		console.log("[mock-slack] react:", req.body.name);
		res.json({ success: true });
	});

	r.post("/claw_slack/reactions/remove", (req, res) => {
		console.log("[mock-slack] unreact:", req.body.name);
		res.json({ success: true });
	});

	return r;
}
