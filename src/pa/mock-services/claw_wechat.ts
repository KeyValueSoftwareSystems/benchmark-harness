import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function clawWechatRoutes(load: FixtureLoader): Router {
	const r = Router();
	const chats = (): any[] => load("claw_wechat/chats.json");
	const moments = (): any[] => load("claw_wechat/moments.json");

	r.post("/claw_wechat/chats/list", (req, res) => {
		res.json({ total: chats().length, chats: chats() });
	});

	r.post("/claw_wechat/chats/get", (req, res) => {
		const { chat_id } = req.body;
		if (!chat_id) return res.json({ error: "chat_id required" });
		const c = chats().find((c) => c.chat_id === chat_id || c.id === chat_id);
		if (!c) return res.status(404).json({ error: "chat not found" });
		res.json(c);
	});

	r.post("/claw_wechat/chats/send", (req, res) => {
		console.log("[mock-wechat] send:", req.body.chat_id);
		res.json({ success: true });
	});

	r.post("/claw_wechat/chats/search", (req, res) => {
		const all = chats();
		const { query } = req.body;
		if (!query) return res.json({ total: all.length, results: all });
		const q = String(query).toLowerCase();
		const filtered = all.filter((c) => JSON.stringify(c).toLowerCase().includes(q));
		res.json({ total: filtered.length, results: filtered });
	});

	r.post("/claw_wechat/chats/mute", (req, res) => {
		console.log("[mock-wechat] mute:", req.body.chat_id);
		res.json({ success: true });
	});

	r.post("/claw_wechat/chats/recall", (req, res) => {
		console.log("[mock-wechat] recall:", req.body.message_id);
		res.json({ success: true });
	});

	r.post("/claw_wechat/moments/browse", (req, res) => {
		res.json({ total: moments().length, moments: moments() });
	});

	r.post("/claw_wechat/moments/post", (req, res) => {
		console.log("[mock-wechat] post moment");
		res.json({ success: true });
	});

	r.post("/claw_wechat/moments/like", (req, res) => {
		console.log("[mock-wechat] like moment:", req.body.moment_id);
		res.json({ success: true });
	});

	r.post("/claw_wechat/moments/comment", (req, res) => {
		console.log("[mock-wechat] comment moment:", req.body.moment_id);
		res.json({ success: true });
	});

	r.post("/claw_wechat/moments/search", (req, res) => {
		const all = moments();
		const { query } = req.body;
		if (!query) return res.json({ total: all.length, results: all });
		const q = String(query).toLowerCase();
		const filtered = all.filter((m) => JSON.stringify(m).toLowerCase().includes(q));
		res.json({ total: filtered.length, results: filtered });
	});

	return r;
}
