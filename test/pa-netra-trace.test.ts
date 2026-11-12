import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { emitPaTrace, type PaTraceData } from "../src/api/netra/trace.ts";
import type { Job } from "../src/shared/types.ts";
import type { LlmRole } from "../src/api/routes/llm.ts";

// Value aliases — avoids a value import of llm.ts which chain-loads config.ts (MGMT_KEY guard).
const persona: LlmRole = "persona";
const paa: LlmRole = "paa";

const job: Job = {
	id: "trace-test-1",
	benchmark: "pa",
	prompt: "test prompt",
	model: "test-model",
	params: { challenge: "email_only_check_inbox", assistant: "openclaw" },
	status: "done",
	createdAt: "2026-11-12T00:00:00.000Z",
};

const T0 = "2026-11-12T00:01:00.000Z";
const T1 = "2026-11-12T00:01:01.000Z";
const T2 = "2026-11-12T00:01:02.000Z";

function makeData(overrides?: Partial<PaTraceData>): PaTraceData {
	return {
		correct: true,
		score: {
			total: 0.85,
			checksScore: 0.35,
			judgeScore: 0.7,
			judgeWeight: 0.5,
			judgeReasoning: "Good work",
			judgeModel: "judge-model",
			judgeFailed: false,
			passThreshold: 0.6,
			safe: true,
			violations: [],
			components: [],
			checks: [],
			items: [],
			toolCallCount: 2,
			toolCallsByService: { gmail: 2 },
			exchanges: 1,
			category: "email",
		llm: {
			paa: { calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.001, costUnknown: false },
			persona: { calls: 1, inputTokens: 80, outputTokens: 40, costUsd: 0.0008, costUnknown: false },
		},
		},
		toolCalls: [
			{ service: "gmail", tool: "gmail_check_inbox", args: {}, ok: true, at: T1 },
			{ service: "gmail", tool: "gmail_search", args: { query: "test" }, ok: false, at: T2 },
		],
		llmCalls: [
			{ role: persona, model: "test-model", startedAt: T0, latencyMs: 500, inputTokens: 80, outputTokens: 40, costUsd: 0.0008, status: 200 },
			{ role: paa, model: "test-model", startedAt: T1, latencyMs: 1000, inputTokens: 100, outputTokens: 50, costUsd: 0.001, status: 200 },
		],
		transcript: [
			{ user_message: "Check my inbox", assistant_reply: "You have 3 emails", timestamp: T1 },
		],
		personaOutcome: { outcome: "satisfied", reason: "All good" },
		...overrides,
	};
}

test("emitPaTrace returns a session id and emits the expected span tree", async () => {
	const exporter = new InMemorySpanExporter();
	const sessionId = await emitPaTrace(job, makeData(), { exporter, environment: "test" });
	assert.ok(sessionId, "should return a session id");

	const spans = exporter.getFinishedSpans();
	// root + 2 llm + 2 tool + 1 exchange = 6
	assert.equal(spans.length, 6, `expected 6 spans, got ${spans.length}`);

	const root = spans.find((s) => s.name === "pa.job");
	assert.ok(root);
	assert.equal(root.attributes["netra.span.type"], "AGENT");
	assert.equal(root.attributes["netra.session_id"], sessionId);
	assert.equal(root.attributes["netra.tenant_id"], "pa");
	assert.equal(root.attributes["pa.world"], "email_only_check_inbox");
	assert.equal(root.attributes["pa.assistant"], "openclaw");
	assert.equal(root.attributes["pa.model"], "test-model");
	assert.equal(root.attributes["pa.total"], "0.85");
	assert.equal(root.attributes["pa.safe"], "true");
	assert.equal(root.attributes["pa.correct"], "true");
	assert.equal(root.attributes["pa.category"], "email");
	assert.equal(root.attributes["netra.status"], "success");

	// All spans share the same trace id
	const traceId = root.spanContext().traceId;
	for (const span of spans) assert.equal(span.spanContext().traceId, traceId, `${span.name} should share trace id`);

	// All children have root as parent
	const rootSpanId = root.spanContext().spanId;
	for (const span of spans.filter((s) => s !== root)) {
		assert.equal((span as any).parentSpanContext?.spanId, rootSpanId, `${span.name} should be a child of root`);
	}
});

test("generation spans carry usage and gen_ai attributes", async () => {
	const exporter = new InMemorySpanExporter();
	await emitPaTrace(job, makeData(), { exporter, environment: "test" });
	const gen = exporter.getFinishedSpans().find((s) => s.name === `llm.${paa}`);
	assert.ok(gen);
	assert.equal(gen.attributes["netra.span.type"], "GENERATION");
	assert.equal(gen.attributes["netra.model"], "test-model");
	assert.equal(gen.attributes["gen_ai.request.model"], "test-model");
	assert.equal(gen.attributes["gen_ai.usage.prompt_tokens"], "100");
	assert.equal(gen.attributes["gen_ai.usage.completion_tokens"], "50");
	assert.equal(gen.attributes["pa.role"], paa);
	const usage = JSON.parse(gen.attributes["netra.usage"] as string);
	assert.equal(usage.length, 2);
	assert.equal(usage[0].usage_type, "input");
	assert.equal(usage[0].units_used, 100);
	assert.equal(usage[1].cost_in_usd, 0.001);
});

test("LLM calls with HTTP errors get error status", async () => {
	const exporter = new InMemorySpanExporter();
	const data = makeData({
		llmCalls: [
			{ role: paa, model: "test-model", startedAt: T0, latencyMs: 100, inputTokens: 0, outputTokens: 0, costUsd: 0, status: 500 },
		],
	});
	await emitPaTrace(job, data, { exporter, environment: "test" });
	const span = exporter.getFinishedSpans().find((s) => s.name === `llm.${paa}`);
	assert.ok(span);
	assert.equal(span.attributes["netra.status"], "error");
});

test("tool spans reflect success/failure and carry service and args", async () => {
	const exporter = new InMemorySpanExporter();
	await emitPaTrace(job, makeData(), { exporter, environment: "test" });
	const spans = exporter.getFinishedSpans();

	const ok = spans.find((s) => s.name === "gmail_check_inbox");
	assert.ok(ok);
	assert.equal(ok.attributes["netra.span.type"], "TOOL");
	assert.equal(ok.attributes["netra.status"], "success");
	assert.equal(ok.attributes["tool.service"], "gmail");

	const fail = spans.find((s) => s.name === "gmail_search");
	assert.ok(fail);
	assert.equal(fail.attributes["netra.status"], "error");
	assert.equal(fail.attributes["tool.args"], '{"query":"test"}');
});

test("exchange spans carry the conversation attribute", async () => {
	const exporter = new InMemorySpanExporter();
	await emitPaTrace(job, makeData(), { exporter, environment: "test" });
	const ex = exporter.getFinishedSpans().find((s) => s.name === "exchange-0");
	assert.ok(ex);
	assert.equal(ex.attributes["netra.span.type"], "SPAN");
	const conv = JSON.parse(ex.attributes["conversation"] as string);
	assert.equal(conv.length, 2);
	assert.equal(conv[0].type, "input");
	assert.equal(conv[0].content, "Check my inbox");
	assert.equal(conv[1].type, "output");
	assert.equal(conv[1].content, "You have 3 emails");
});

test("with no tool calls or transcript, only root and LLM spans are emitted", async () => {
	const exporter = new InMemorySpanExporter();
	const data = makeData({ toolCalls: undefined, transcript: [] });
	await emitPaTrace(job, data, { exporter, environment: "test" });
	const spans = exporter.getFinishedSpans();
	assert.equal(spans.length, 3); // root + 2 llm
	assert.ok(spans.some((s) => s.attributes["netra.span.type"] === "AGENT"));
	assert.equal(spans.filter((s) => s.attributes["netra.span.type"] === "GENERATION").length, 2);
});

test("persona outcome is stored as a JSON attribute on the root span", async () => {
	const exporter = new InMemorySpanExporter();
	await emitPaTrace(job, makeData(), { exporter, environment: "test" });
	const root = exporter.getFinishedSpans().find((s) => s.name === "pa.job");
	assert.ok(root);
	const parsed = JSON.parse(root.attributes["pa.personaOutcome"] as string);
	assert.equal(parsed.outcome, "satisfied");
});

test("persona outcome attribute is omitted when null", async () => {
	const exporter = new InMemorySpanExporter();
	await emitPaTrace(job, makeData({ personaOutcome: null }), { exporter, environment: "test" });
	const root = exporter.getFinishedSpans().find((s) => s.name === "pa.job");
	assert.ok(root);
	assert.equal(root.attributes["pa.personaOutcome"], undefined);
});

test("returns undefined without env vars and no exporter option", async () => {
	const origEndpoint = process.env.NETRA_OTLP_ENDPOINT;
	const origKey = process.env.NETRA_API_KEY;
	delete process.env.NETRA_OTLP_ENDPOINT;
	delete process.env.NETRA_API_KEY;
	try {
		const result = await emitPaTrace(job, makeData());
		assert.equal(result, undefined);
	} finally {
		if (origEndpoint !== undefined) process.env.NETRA_OTLP_ENDPOINT = origEndpoint;
		if (origKey !== undefined) process.env.NETRA_API_KEY = origKey;
	}
});

test("null score values become empty-string attributes", async () => {
	const exporter = new InMemorySpanExporter();
	const data = makeData({
		correct: null,
		score: {
			...makeData().score,
			total: null,
			checksScore: null,
			judgeScore: null,
			safe: null,
			toolCallCount: null,
		},
	});
	await emitPaTrace(job, data, { exporter, environment: "test" });
	const root = exporter.getFinishedSpans().find((s) => s.name === "pa.job");
	assert.ok(root);
	assert.equal(root.attributes["pa.total"], "");
	assert.equal(root.attributes["pa.correct"], "");
	assert.equal(root.attributes["pa.safe"], "");
});

test("resource attributes include service.name and deployment.environment", async () => {
	const exporter = new InMemorySpanExporter();
	await emitPaTrace(job, makeData(), { exporter, environment: "staging" });
	const root = exporter.getFinishedSpans().find((s) => s.name === "pa.job");
	assert.ok(root);
	const resource = root.resource;
	assert.equal(resource.attributes["service.name"], "pa");
	assert.equal(resource.attributes["deployment.environment"], "staging");
});
