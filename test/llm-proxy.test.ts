import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { Redis } from "ioredis";

const OPENAI_STREAM = (withUsage: boolean) =>
	[
		`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hel"}}]}`,
		`data: {"id":"c1","choices":[{"index":0,"delta":{"content":"lo"}}],"usage":null}`,
		...(withUsage ? [`data: {"id":"c1","choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7,"total_tokens":127}}`] : []),
		"data: [DONE]",
		"",
	].join("\n\n");
const ANTHROPIC_STREAM = [
	`event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":300,"output_tokens":1}}}`,
	`event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
	`event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}`,
	`event: message_stop\ndata: {"type":"message_stop"}`,
	"",
].join("\n\n");

// A stub provider: rate-limits /limited, and answers chat completions and messages, streamed or not.
const upstream = createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		const body = raw ? JSON.parse(raw) : null;
		if (req.url === "/v1/limited") {
			res.writeHead(429, { "content-type": "application/json", "retry-after": "5", "x-request-id": "req-1" });
			return void res.end(JSON.stringify({ error: "rate limited", received: body }));
		}
		if (req.url === "/v1/chat/completions" && body?.stream) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			// Split mid-line to check the scanner reassembles lines across chunks.
			const text = OPENAI_STREAM(body.stream_options?.include_usage === true);
			res.write(text.slice(0, 37));
			return void setTimeout(() => res.end(text.slice(37)), 5);
		}
		if (req.url === "/v1/chat/completions") {
			res.writeHead(200, { "content-type": "application/json" });
			return void res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
		}
		if (req.url === "/v1/messages" && body?.stream) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(ANTHROPIC_STREAM.slice(0, 50));
			return void setTimeout(() => res.end(ANTHROPIC_STREAM.slice(50)), 5);
		}
		if (req.url === "/v1/messages") {
			res.writeHead(200, { "content-type": "application/json" });
			return void res.end(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 50, output_tokens: 5 } }));
		}
		res.writeHead(404).end();
	});
}).listen(0);
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

process.env.MGMT_KEY = "test";
process.env.API_CONTAINER_NAME = "test";
process.env.MODELS = JSON.stringify([
	{ name: "m", baseUrl: upstreamUrl, apiKey: "real-key", api: "openai-completions", modelId: "real-model", cost: { input: 2, output: 10 } },
	{ name: "a", baseUrl: upstreamUrl, apiKey: "real-key", api: "anthropic-messages", modelId: "claude" },
]);
const { createUsageScanner, extractToken, llmRouter, readLlmToken, withStreamUsage } = await import("../src/api/routes/llm.ts");

const TOKENS: Record<string, string> = {
	"llm-token:tok": JSON.stringify({ jobId: "j1", role: "persona" }),
	"llm-token:paatok": JSON.stringify({ jobId: "j1", role: "paa" }),
	"llm-token:atok": JSON.stringify({ jobId: "j2", role: "paa" }),
	"llm-token:legacy": "j1",
};
const JOBS: Record<string, Record<string, string>> = {
	"job:j1": { id: "j1", model: "m", benchmark: "pa", status: "running" },
	"job:j2": { id: "j2", model: "a", benchmark: "pa", status: "running" },
};
const logged: { key: string; value: Record<string, unknown> }[] = [];

/** Just enough of ioredis for the proxy. */
const redis = {
	get: async (key: string) => TOKENS[key] ?? null,
	incr: async () => 1,
	hgetall: async (key: string) => JOBS[key] ?? {},
	hset: async () => 1,
	multi() {
		const chain = {
			rpush: (key: string, value: string) => (logged.push({ key, value: JSON.parse(value) }), chain),
			expire: () => chain,
			exec: async () => [],
		};
		return chain;
	},
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

const call = (path: string, token: string, body: unknown) =>
	fetch(`${base}/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

/** The call is logged after the last byte reaches the client, so wait for it. */
async function nextLog(before: number) {
	for (let i = 0; i < 100 && logged.length <= before; i++) await new Promise((r) => setTimeout(r, 5));
	assert.ok(logged.length > before, "no call was logged");
	return logged[logged.length - 1];
}

test("upstream headers such as retry-after reach the client", async () => {
	const res = await call("limited", "tok", { model: "anything", messages: [] });
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

test("a token's value carries its job and role; a malformed value is rejected", async () => {
	assert.deepEqual(await readLlmToken(redis, "paatok"), { jobId: "j1", role: "paa" });
	assert.equal(await readLlmToken(redis, "legacy"), undefined);
	assert.equal(await readLlmToken(redis, "nope"), undefined);
	const res = await call("chat/completions", "legacy", { messages: [] });
	assert.equal(res.status, 403);
});

test("non-streaming openai: usage, cost and the caller's role are logged", async () => {
	const before = logged.length;
	const res = await call("chat/completions", "tok", { messages: [] });
	assert.equal(res.status, 200);
	await res.json();
	const { key, value } = await nextLog(before);
	assert.equal(key, "llm-call-log:j1");
	assert.equal(value.role, "persona");
	assert.equal(value.model, "m");
	assert.equal(value.inputTokens, 1000);
	assert.equal(value.outputTokens, 200);
	assert.equal(value.costUsd, (1000 * 2 + 200 * 10) / 1_000_000);
	assert.equal(value.costUnknown, undefined);
	assert.equal(value.status, 200);
	assert.equal(typeof value.latencyMs, "number");
	assert.ok(!JSON.stringify(value).includes("real-key"));
});

test("streaming openai: include_usage is injected, bytes are unchanged and usage is read from the last chunk", async () => {
	const before = logged.length;
	const res = await call("chat/completions", "paatok", { messages: [], stream: true });
	assert.equal(await res.text(), OPENAI_STREAM(true));
	const { value } = await nextLog(before);
	assert.equal(value.role, "paa");
	assert.equal(value.inputTokens, 120);
	assert.equal(value.outputTokens, 7);
});

test("non-streaming anthropic: usage is read, and a model without prices is marked costUnknown", async () => {
	const before = logged.length;
	const res = await call("messages", "atok", { messages: [] });
	await res.json();
	const { key, value } = await nextLog(before);
	assert.equal(key, "llm-call-log:j2");
	assert.deepEqual([value.inputTokens, value.outputTokens, value.costUsd, value.costUnknown], [50, 5, 0, true]);
});

test("streaming anthropic: bytes are unchanged and usage comes from message_start and message_delta", async () => {
	const before = logged.length;
	const res = await call("messages", "atok", { messages: [], stream: true });
	assert.equal(await res.text(), ANTHROPIC_STREAM);
	const { value } = await nextLog(before);
	assert.deepEqual([value.inputTokens, value.outputTokens], [300, 42]);
});

test("withStreamUsage only touches streamed openai chat completions and keeps other stream options", () => {
	assert.deepEqual(withStreamUsage("openai-completions", { stream: true, stream_options: { x: 1 } }), { stream: true, stream_options: { x: 1, include_usage: true } });
	assert.deepEqual(withStreamUsage("openai-completions", { stream: false }), { stream: false });
	assert.deepEqual(withStreamUsage("anthropic-messages", { stream: true }), { stream: true });
});

test("the usage scanner tolerates junk and reports nothing when there is no usage", () => {
	const sse = createUsageScanner("text/event-stream");
	sse.push("data: not json\n\n: comment\n\ndata: {\"choices\":[]}\n\n");
	assert.equal(sse.finish(), undefined);
	const json = createUsageScanner("application/json");
	json.push(Buffer.from("{\"usage\":{\"input_tokens\":3,"));
	json.push(Buffer.from("\"output_tokens\":4}}"));
	assert.deepEqual(json.finish(), { inputTokens: 3, outputTokens: 4 });
});
