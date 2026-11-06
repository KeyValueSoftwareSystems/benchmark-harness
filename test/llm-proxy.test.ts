import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { Redis } from "ioredis";

// A stub provider that rate-limits every call, sending the headers a client needs to back off.
const upstream = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		res.writeHead(429, { "content-type": "application/json", "retry-after": "5", "x-request-id": "req-1" });
		res.end(JSON.stringify({ error: "rate limited", received: body ? JSON.parse(body) : null }));
	});
}).listen(0);
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

process.env.MGMT_KEY = "test";
process.env.API_CONTAINER_NAME = "test";
process.env.MODELS = JSON.stringify([{ name: "m", baseUrl: upstreamUrl, apiKey: "real-key", api: "openai-completions", modelId: "real-model" }]);
const { extractToken, llmRouter } = await import("../src/api/routes/llm.ts");

/** Just enough of ioredis for the proxy: one valid token for job j1, which uses model m. */
const redis = {
	get: async (key: string) => (key === "llm-token:tok" ? "j1" : null),
	incr: async () => 1,
	hgetall: async (key: string) => (key === "job:j1" ? { id: "j1", model: "m", benchmark: "pa", status: "running" } : {}),
	hset: async () => 1,
} as unknown as Redis;

const app = express();
app.use("/llm", express.json());
app.use(llmRouter(redis));
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/llm/v1`;
test.after(() => {
	server.close();
	upstream.close();
});

test("upstream headers such as retry-after reach the client", async () => {
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { authorization: "Bearer tok", "content-type": "application/json" },
		body: JSON.stringify({ model: "anything", messages: [] }),
	});
	assert.equal(res.status, 429);
	assert.equal(res.headers.get("retry-after"), "5");
	assert.equal(res.headers.get("x-request-id"), "req-1");
	const body = (await res.json()) as { received: { model: string } };
	assert.equal(body.received.model, "real-model");
});

test("a non-JSON body is rejected with 415", async () => {
	const res = await fetch(`${base}/chat/completions`, {
		method: "POST",
		headers: { authorization: "Bearer tok", "content-type": "text/plain" },
		body: "hello",
	});
	assert.equal(res.status, 415);
});

test("extractToken accepts any scheme case and trims", () => {
	const t = (headers: Record<string, string>) => extractToken({ headers });
	assert.equal(t({ authorization: "bearer abc" }), "abc");
	assert.equal(t({ authorization: "Bearer abc " }), "abc");
	assert.equal(t({ "x-api-key": " abc " }), "abc");
	assert.equal(t({ authorization: "Basic xyz", "x-api-key": "abc" }), "abc");
	assert.equal(t({ authorization: "Bearer   ", "x-api-key": "abc" }), "abc");
	assert.equal(t({ authorization: "Bearer win", "x-api-key": "lose" }), "win");
});
