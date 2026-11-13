#!/usr/bin/env node
/**
 * Chat adapter for the PAA container.
 *
 * Translates between the benchmark protocol ({conversation_id, message} / {response})
 * and the assistant's OpenAI-compatible /v1/chat/completions API.
 *
 * Maintains an in-memory conversation history per conversation_id so the
 * stateless OpenAI endpoint sees the full message history on every call.
 */

import express from "express";
import { Agent, fetch } from "undici";
import { PAA_CHAT_PORT, PAA_HEALTH_PATH } from "../constants.ts";

// An assistant turn can take longer than fetch's default 5-minute header wait; the job timeout bounds it instead.
const noTimeout = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const UPSTREAM_URL = requiredEnv("PAA_UPSTREAM_URL");
const UPSTREAM_MODEL = requiredEnv("PAA_UPSTREAM_MODEL");
const UPSTREAM_TOKEN = requiredEnv("PAA_GATEWAY_TOKEN");
const PORT = Number(process.env.CHAT_ADAPTER_PORT ?? PAA_CHAT_PORT);

interface Message {
	role: "system" | "user" | "assistant";
	content: string;
}

const conversations = new Map<string, Message[]>();

const app = express();
app.use(express.json());

/** Health check — returns 200 when the adapter process is alive. */
app.get(PAA_HEALTH_PATH, (_req, res) => {
	res.json({ ok: true });
});

/**
 * POST /chat
 * Body:  { conversation_id: string, message: string }
 * Reply: { response: string }
 */
app.post("/chat", async (req, res) => {
	const { conversation_id, message } = req.body ?? {};

	if (!conversation_id || typeof message !== "string") {
		res.status(400).json({ error: "conversation_id (string) and message (string) are required" });
		return;
	}

	let history = conversations.get(conversation_id);
	if (!history) {
		history = [];
		conversations.set(conversation_id, history);
	}

	history.push({ role: "user", content: message });

	try {
		const upstream = await fetch(UPSTREAM_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${UPSTREAM_TOKEN}`,
			},
			body: JSON.stringify({
				model: UPSTREAM_MODEL,
				messages: history,
			}),
			dispatcher: noTimeout,
		});

		if (!upstream.ok) {
			const body = await upstream.text();
			console.error(`[chat-adapter] assistant returned ${upstream.status}: ${body}`);
			res.status(502).json({ error: `upstream ${upstream.status}`, detail: body });
			return;
		}

		const data = (await upstream.json()) as any;
		const assistantContent: string =
			data?.choices?.[0]?.message?.content ?? "";

		history.push({ role: "assistant", content: assistantContent });

		res.json({ response: assistantContent });
	} catch (err: any) {
		console.error("[chat-adapter] fetch error:", err.message);
		res.status(502).json({ error: "upstream unreachable", detail: err.message });
	}
});

app.listen(PORT, () => {
	console.error(`[chat-adapter] listening on :${PORT}`);
});
