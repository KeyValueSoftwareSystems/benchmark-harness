import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLlmCallTrace } from "../src/api/llm-call-trace.ts";
import type { LlmCallRecord } from "../src/api/routes/llm.ts";

const record = (role: LlmCallRecord["role"], costUsd: number): LlmCallRecord => ({
	role,
	model: "m",
	startedAt: "2026-01-01T00:00:00.000Z",
	latencyMs: 5,
	inputTokens: 10,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 2,
	costUsd,
	status: 200,
});
const reply = { text: "x", toolCalls: [] };
const msg = (content: string) => ({ role: "user", content });

async function lines(dir: string, jobId: string) {
	return (await readFile(path.join(dir, `${jobId}.jsonl`), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

test("each call is one line with a running cost; later requests hold only new messages", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "trace-"));
	const trace = createLlmCallTrace(dir);
	await trace.append("j1", 1, record("paa", 0.25), { model: "m", messages: [msg("a")] }, reply);
	await trace.append("j1", 2, record("paa", 0.5), { model: "m", messages: [msg("a"), msg("b")] }, reply);
	const [first, second] = await lines(dir, "j1");
	assert.equal(first.call, 1);
	assert.equal(first.request.continuesPreviousCall, false);
	assert.deepEqual(first.request.body.messages, [msg("a")]);
	assert.equal(first.runningCostUsd, 0.25);
	assert.equal(second.runningCostUsd, 0.75);
	assert.deepEqual(second.request, { messages: [msg("b")], continuesPreviousCall: true });
});

test("a rewritten history is stored in full, and roles keep separate histories", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "trace-"));
	const trace = createLlmCallTrace(dir);
	await trace.append("j2", 1, record("paa", 0), { messages: [msg("a"), msg("b")] }, reply);
	await trace.append("j2", 2, record("persona", 0), { messages: [msg("p")] }, reply);
	await trace.append("j2", 3, record("paa", 0), { messages: [msg("compacted")] }, reply);
	const [, persona, rewritten] = await lines(dir, "j2");
	assert.equal(persona.request.continuesPreviousCall, false);
	assert.equal(rewritten.request.continuesPreviousCall, false);
	assert.deepEqual(rewritten.request.body.messages, [msg("compacted")]);
});

test("a failed call records its error", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "trace-"));
	await createLlmCallTrace(dir).append("j3", 1, { ...record("paa", 0), status: 502 }, undefined, reply, "boom");
	const [line] = await lines(dir, "j3");
	assert.equal(line.error, "boom");
	assert.equal(line.request, null);
});
