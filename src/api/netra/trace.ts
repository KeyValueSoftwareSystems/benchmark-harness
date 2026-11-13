/**
 * Emits one OpenTelemetry trace per PA job to the Netra OTLP endpoint.
 * Each call creates a throwaway BasicTracerProvider so nothing touches global OTel state.
 */

import { randomUUID } from "node:crypto";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { ExportResultCode } from "@opentelemetry/core";

import type { Job } from "../../shared/types.ts";
import type { LlmCallRecord } from "../routes/llm.ts";
import type { ToolCallRecord } from "../../pa/constants.ts";
import type { Exchange } from "../../pa/grading/judge.ts";
import type { PaScore } from "../../pa/grading/score.ts";

const TENANT = "pa";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaTraceData {
	correct: boolean | null;
	score: PaScore;
	toolCalls: ToolCallRecord[] | undefined;
	llmCalls: LlmCallRecord[];
	transcript: Exchange[];
	personaOutcome: Record<string, unknown> | null;
}

export interface PaTraceOptions {
	endpoint?: string;
	apiKey?: string;
	environment?: string;
	/** Replaces the default HTTP exporter (for tests). */
	exporter?: SpanExporter;
}

// ---------------------------------------------------------------------------
// Exporter: buffers spans and POSTs them in one OTLP JSON request on flush
// ---------------------------------------------------------------------------

function createHttpExporter(endpoint: string, apiKey: string): SpanExporter {
	const url = endpoint.endsWith("/v1/traces")
		? endpoint
		: `${endpoint.replace(/\/+$/, "")}/v1/traces`;
	const buffer: ReadableSpan[] = [];
	let flushed = false;

	async function flush(): Promise<void> {
		if (flushed || !buffer.length) return;
		flushed = true;
		const body = JsonTraceSerializer.serializeRequest(buffer);
		if (!body) throw new Error("OTLP serialization failed");
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-api-key": apiKey },
			body: Buffer.from(body),
		});
		if (!res.ok) throw new Error(`Netra OTLP export: HTTP ${res.status}`);
	}

	return {
		export(spans: ReadableSpan[], cb: (result: { code: number }) => void) {
			buffer.push(...spans);
			cb({ code: ExportResultCode.SUCCESS });
		},
		forceFlush: flush,
		shutdown: flush,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const str = (v: unknown): string =>
	v === null || v === undefined ? "" : String(v);

function earliest(data: PaTraceData): number {
	const t: number[] = [];
	for (const c of data.llmCalls) t.push(Date.parse(c.startedAt));
	for (const c of data.toolCalls ?? []) t.push(Date.parse(c.at));
	for (const e of data.transcript) if (e.timestamp) t.push(Date.parse(e.timestamp));
	return t.length ? Math.min(...t) : Date.now();
}

function latest(data: PaTraceData): number {
	const t: number[] = [];
	for (const c of data.llmCalls) t.push(Date.parse(c.startedAt) + c.latencyMs);
	for (const c of data.toolCalls ?? []) t.push(Date.parse(c.at) + 1);
	for (const e of data.transcript) if (e.timestamp) t.push(Date.parse(e.timestamp) + 1);
	return t.length ? Math.max(...t) : Date.now();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Emits one OTLP trace to Netra for a scored PA job and returns the new session id,
 * or `undefined` when tracing is not configured or the export fails.
 */
export async function emitPaTrace(
	job: Job,
	data: PaTraceData,
	options?: PaTraceOptions,
): Promise<string | undefined> {
	const endpoint = options?.endpoint ?? (process.env.NETRA_OTLP_ENDPOINT ?? "");
	const apiKey = options?.apiKey ?? (process.env.NETRA_API_KEY ?? "");
	const environment = options?.environment ?? (process.env.NETRA_ENV ?? "local");

	if (!options?.exporter && (!endpoint || !apiKey)) return undefined;

	const sessionId = randomUUID();
	const exporter = options?.exporter ?? createHttpExporter(endpoint, apiKey);

	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes({
			"service.name": "pa",
			"deployment.environment": environment,
		}),
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});

	const tracer = provider.getTracer("pa");
	const common: Record<string, string> = {
		"netra.session_id": sessionId,
		"netra.tenant_id": TENANT,
	};

	try {
		const rootStart = earliest(data);
		const rootEnd = latest(data);

		// ---- Root span: pa.job (AGENT) ----
		const root = tracer.startSpan("pa.job", {
			kind: SpanKind.CLIENT,
			startTime: rootStart,
			attributes: {
				...common,
				"netra.span.type": "AGENT",
				"netra.span.name": "pa.job",
				"pa.world": job.params?.challenge ?? "",
				"pa.category": data.score.category ?? "",
				"pa.assistant": job.params?.assistant ?? "",
				"pa.model": job.model,
				"pa.total": str(data.score.total),
				"pa.checksScore": str(data.score.checksScore),
				"pa.judgeScore": str(data.score.judgeScore),
				"pa.judgeWeight": str(data.score.judgeWeight),
				"pa.passThreshold": str(data.score.passThreshold),
				"pa.safe": str(data.score.safe),
				"pa.correct": str(data.correct),
				"pa.violations": str(data.score.violations.length),
				"pa.exchanges": str(data.score.exchanges),
				"pa.toolCallCount": str(data.score.toolCallCount),
				"pa.judgeFailed": String(data.score.judgeFailed),
				...(data.personaOutcome && {
					"pa.personaOutcome": JSON.stringify(data.personaOutcome),
				}),
			},
		});
		const rootCtx = trace.setSpan(context.active(), root);

		// ---- One GENERATION span per LLM call ----
		for (const call of data.llmCalls) {
			const start = Date.parse(call.startedAt);
			const end = start + call.latencyMs;
			const span = tracer.startSpan(`llm.${call.role}`, {
				kind: SpanKind.CLIENT,
				startTime: start,
				attributes: {
					...common,
					"netra.span.type": "GENERATION",
					"netra.span.name": `llm.${call.role}`,
					"netra.model": call.model,
					"netra.duration_ms": call.latencyMs.toFixed(2),
					"netra.usage": JSON.stringify([
						{ model: call.model, usage_type: "input", units_used: call.inputTokens },
						{ model: call.model, usage_type: "output", units_used: call.outputTokens, cost_in_usd: call.costUsd },
					]),
					"gen_ai.request.model": call.model,
					"gen_ai.usage.prompt_tokens": String(call.inputTokens),
					"gen_ai.usage.completion_tokens": String(call.outputTokens),
					"pa.role": call.role,
					"pa.status": String(call.status),
				},
			}, rootCtx);
			if (call.status >= 400) {
				span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${call.status}` });
				span.setAttribute("netra.status", "error");
			} else {
				span.setStatus({ code: SpanStatusCode.OK });
				span.setAttribute("netra.status", "success");
			}
			span.end(end);
		}

		// ---- One TOOL span per tool call ----
		for (const call of data.toolCalls ?? []) {
			const at = Date.parse(call.at);
			const span = tracer.startSpan(call.tool, {
				kind: SpanKind.CLIENT,
				startTime: at,
				attributes: {
					...common,
					"netra.span.type": "TOOL",
					"netra.span.name": call.tool,
					"netra.status": call.ok ? "success" : "error",
					"tool.service": call.service,
					"tool.args": typeof call.args === "string" ? call.args : JSON.stringify(call.args),
				},
			}, rootCtx);
			if (call.ok) span.setStatus({ code: SpanStatusCode.OK });
			else span.setStatus({ code: SpanStatusCode.ERROR });
			span.end(at + 1);
		}

		// ---- One SPAN per conversation exchange ----
		for (let i = 0; i < data.transcript.length; i++) {
			const ex = data.transcript[i];
			const at = ex.timestamp ? Date.parse(ex.timestamp) : rootStart + i + 1;
			const span = tracer.startSpan(`exchange-${i}`, {
				kind: SpanKind.CLIENT,
				startTime: at,
				attributes: {
					...common,
					"netra.span.type": "SPAN",
					"netra.span.name": `exchange-${i}`,
					"netra.status": "success",
					"conversation": JSON.stringify([
						{ type: "input", role: "user", content: ex.user_message, format: "text" },
						{ type: "output", role: "assistant", content: ex.assistant_reply, format: "text" },
					]),
				},
			}, rootCtx);
			span.setStatus({ code: SpanStatusCode.OK });
			span.end(at + 1);
		}

		// ---- Close root ----
		root.setAttribute("netra.status", "success");
		root.setAttribute("netra.duration_ms", (rootEnd - rootStart).toFixed(2));
		root.setStatus({ code: SpanStatusCode.OK });
		root.end(rootEnd);

		await provider.forceFlush();
		// Shutdown sends/clears the exporter; skip it for injected (test) exporters whose lifecycle the caller owns.
		if (!options?.exporter) await provider.shutdown();
		return sessionId;
	} catch (err) {
		console.error(`[netra] job ${job.id}: trace emission failed: ${err}`);
		try { if (!options?.exporter) await provider.shutdown(); } catch { /* already broken */ }
		return undefined;
	}
}
