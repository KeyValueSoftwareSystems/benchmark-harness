/**
 * LLM proxy: lets job containers call model APIs without holding real keys.
 *
 * Each container gets a job-scoped bearer token. The proxy validates it,
 * looks up the job's model, and forwards the request with the real API key.
 * The real key is never logged; use `redact()` from `src/shared/types.ts`.
 *
 * `/llm/v1/<path>` is forwarded to `${model.baseUrl}/<path>`, so `/llm/v1`
 * stands in for a versioned base URL such as `https://api.openai.com/v1`
 * (or `https://api.anthropic.com/v1` for Anthropic-format models).
 * Auth tokens are accepted from either Authorization: Bearer or x-api-key.
 * Responses are streamed back as they arrive, so streaming (SSE) calls stay streaming. A pass-through scanner reads
 * token usage from the bytes on their way to the client, and each call is logged per job with the caller's role.
 */

import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { Router } from "express";
import type { Redis } from "ioredis";
import { Agent, fetch } from "undici";
import { createReplyCollector } from "../../shared/llm-reply.ts";
import { callCost, createUsageScanner, type LlmUsage } from "../../shared/llm-usage.ts";
import { JOB_DATA_TTL_S, MODELS, RESULTS_DIR } from "../config.ts";
import { createLlmCallTrace, type LlmCallTrace } from "../llm-call-trace.ts";
import { getJob, keys, setStatus } from "../queue/store.ts";

/** Cap on model calls through the proxy per job, counting both the pi agent and the PAA. */
const LLM_MAX_CALLS_PER_JOB = Number(process.env.LLM_MAX_CALLS_PER_JOB ?? 10_000);

// Long generations can exceed fetch's default 5-minute waits; the job timeout bounds them instead.
const noTimeout = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** API formats the proxy can forward: the model is named in the body and auth is a single header. */
export const PROXY_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

/** Error code of a stream that closed before it finished; once the reply's end marker was seen it means the client closed first. */
const PREMATURE_CLOSE_CODE = "ERR_STREAM_PREMATURE_CLOSE";

/** Where each job's call trace is written: `<dir>/<jobId>.jsonl`. */
export const LLM_TRACE_DIR = path.join(RESULTS_DIR, "llm-calls");

/** Where the proxy is mounted; the PAA and the pi agent send their model calls here. */
export const LLM_ROUTE = "/llm/v1";
/** Header names the proxy reads the job token from, and writes the real key to. */
export const AUTH_HEADERS = { bearer: "authorization", apiKey: "x-api-key" } as const;

/** Headers that must not be forwarded upstream. */
const STRIP_HEADERS = new Set(["host", "content-length", AUTH_HEADERS.bearer, AUTH_HEADERS.apiKey, "connection"]);
/**
 * Upstream response headers that are not passed back: hop-by-hop ones, and those describing the body as sent
 * upstream (fetch has already decompressed it, and it is re-streamed with its own framing).
 */
const STRIP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);

/**
 * The proxy base URL a client should be given for a model's API format. pi's Anthropic client (like the
 * Anthropic SDK) appends /v1/messages to its base URL itself; OpenAI-style clients expect the /v1 included.
 */
export function proxyBaseUrl(apiBase: string, api: string): string {
	return api === "anthropic-messages" ? `${apiBase}/llm` : `${apiBase}${LLM_ROUTE}`;
}

/** Who in a job made a model call: the pi agent playing the user, or the personal assistant under test. */
export const LlmRole = { persona: "persona", paa: "paa" } as const;
export type LlmRole = (typeof LlmRole)[keyof typeof LlmRole];
const isLlmRole = (value: unknown): value is LlmRole => value === LlmRole.persona || value === LlmRole.paa;

/** What a job token's Redis value holds. */
export interface LlmTokenInfo {
	jobId: string;
	role: LlmRole;
}

/** One model call through the proxy, as logged in `keys.llmCallLog(jobId)`. Never holds tokens, keys or bodies. */
export interface LlmCallRecord {
	role: LlmRole;
	model: string;
	/** ISO timestamp of when the proxy received the call. */
	startedAt: string;
	/** Until the last byte reached the client. */
	latencyMs: number;
	/** All prompt tokens, including cached ones. */
	inputTokens: number;
	/** Prompt tokens served from the provider's cache. */
	cacheReadTokens: number;
	/** Prompt tokens written to the provider's cache. */
	cacheWriteTokens: number;
	outputTokens: number;
	costUsd: number;
	/** The provider's own billed USD for the call, when its response reports one. */
	providerCostUsd?: number;
	/** The model has no `cost` in MODELS, so `costUsd` is 0 rather than the real cost. */
	costUnknown?: boolean;
	/** Upstream HTTP status; 502 when the upstream was unreachable. */
	status: number;
}

/**
 * Store a job-scoped LLM token in Redis.  Called by the benchmark handler
 * when a job starts so the proxy can validate incoming requests.
 */
export async function storeLlmToken(redis: Redis, token: string, jobId: string, role: LlmRole): Promise<void> {
	const value: LlmTokenInfo = { jobId, role };
	await redis.set(keys.llmToken(token), JSON.stringify(value), "EX", JOB_DATA_TTL_S);
}

/** The job and role a token belongs to; undefined for an unknown, expired or malformed token. */
export async function readLlmToken(redis: Redis, token: string): Promise<LlmTokenInfo | undefined> {
	const raw = await redis.get(keys.llmToken(token));
	if (!raw) return undefined;
	try {
		const value = JSON.parse(raw) as Partial<LlmTokenInfo>;
		return typeof value.jobId === "string" && isLlmRole(value.role) ? { jobId: value.jobId, role: value.role } : undefined;
	} catch {
		return undefined;
	}
}

/** Remove a job's LLM token (cleanup). */
export async function removeLlmToken(redis: Redis, token: string): Promise<void> {
	await redis.del(keys.llmToken(token));
}

/** Every model call logged for a job, oldest first. */
export async function listLlmCalls(redis: Redis, jobId: string): Promise<LlmCallRecord[]> {
	return (await redis.lrange(keys.llmCallLog(jobId), 0, -1)).map((line) => JSON.parse(line) as LlmCallRecord);
}

/** Asks for the usage chunk at the end of an OpenAI chat-completions stream; other requests are left as they are. */
export function withStreamUsage(api: string, body: Record<string, unknown>): Record<string, unknown> {
	if (api !== "openai-completions" || body.stream !== true) return body;
	const options = body.stream_options && typeof body.stream_options === "object" ? body.stream_options : {};
	return { ...body, stream_options: { ...options, include_usage: true } };
}

async function logCall(redis: Redis, jobId: string, record: LlmCallRecord): Promise<void> {
	const key = keys.llmCallLog(jobId);
	await redis.multi().rpush(key, JSON.stringify(record)).expire(key, JOB_DATA_TTL_S).exec();
}

/**
 * Extract the job-scoped token. A well-formed `Authorization: Bearer <token>` header wins (the scheme is
 * case-insensitive); otherwise `x-api-key` is used. Both are trimmed.
 */
export function extractToken(req: { headers: Record<string, any> }): string {
	const auth = req.headers[AUTH_HEADERS.bearer];
	const bearer = typeof auth === "string" ? /^Bearer\s+(.+)$/i.exec(auth)?.[1].trim() : undefined;
	if (bearer) return bearer;
	const xApiKey = req.headers[AUTH_HEADERS.apiKey];
	return typeof xApiKey === "string" ? xApiKey.trim() : "";
}

export function llmRouter(redis: Redis, callTrace: LlmCallTrace = createLlmCallTrace(LLM_TRACE_DIR)): Router {
	const router = Router();

	router.all(`${LLM_ROUTE}/{*path}`, async (req, res) => {
		const token = extractToken(req);
		if (!token) {
			res.status(401).json({ error: "missing auth token (send Authorization: Bearer or x-api-key)" });
			return;
		}

		const caller = await readLlmToken(redis, token);
		if (!caller) {
			res.status(403).json({ error: "invalid or expired token" });
			return;
		}
		const { jobId, role } = caller;

		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		if (hasBody && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) {
			res.status(415).json({ error: "request body must be a JSON object (send content-type: application/json)" });
			return;
		}

		const count = await redis.incr(keys.llmCalls(jobId));
		if (count > LLM_MAX_CALLS_PER_JOB) {
			const errMsg = `LLM call limit (LLM_MAX_CALLS_PER_JOB=${LLM_MAX_CALLS_PER_JOB}) exceeded. Job ${jobId} has made ${count} calls.`;
			console.error(`[llm-proxy] ${errMsg}`);
			await setStatus(redis, jobId, "error", errMsg);
			res.status(429).json({ error: errMsg });
			return;
		}

		const job = await getJob(redis, jobId);
		if (!job) {
			res.status(404).json({ error: "job not found" });
			return;
		}

		const model = MODELS.find((m) => m.name === job.model);
		if (!model) {
			res.status(404).json({ error: "model not configured" });
			return;
		}

		// The sub-path after /llm/v1/ (e.g. "chat/completions" or "messages").
		// Express 5 wildcard params are string arrays, one element per segment.
		const subpath = (req.params.path as string[]).join("/");
		const query = req.originalUrl.indexOf("?");
		// pi expects Anthropic base URLs without the version (it appends /v1/messages itself); accept both forms.
		const base = model.api === "anthropic-messages" ? `${model.baseUrl.replace(/\/v1\/?$/, "")}/v1` : model.baseUrl;
		const upstreamUrl = `${base}/${subpath}${query === -1 ? "" : req.originalUrl.slice(query)}`;

		// Preserve request headers except auth-related ones (we'll set the real key).
		const fwdHeaders: Record<string, string> = {};
		for (const [key, val] of Object.entries(req.headers)) {
			if (STRIP_HEADERS.has(key) || typeof val !== "string") continue;
			fwdHeaders[key] = val;
		}

		// Set the correct auth for the upstream API.
		if (model.api === "anthropic-messages") {
			fwdHeaders[AUTH_HEADERS.apiKey] = model.apiKey;
		} else {
			fwdHeaders[AUTH_HEADERS.bearer] = `Bearer ${model.apiKey}`;
		}

		// Replace the model field in the body with the real model ID.
		const requestBody = hasBody ? withStreamUsage(model.api, { ...req.body, model: model.modelId }) : undefined;
		const body = requestBody && JSON.stringify(requestBody);

		const started = Date.now();
		let status = 502;
		let scanner: ReturnType<typeof createUsageScanner> | undefined;
		let replyCollector: ReturnType<typeof createReplyCollector> | undefined;
		let failure: string | undefined;
		try {
			console.error(`[llm-proxy] job=${jobId} role=${role} ${req.method} /${subpath} model=${model.name} calls=${count}`);
			const upstream = await fetch(upstreamUrl, {
				method: req.method,
				headers: fwdHeaders,
				body,
				dispatcher: noTimeout,
			});
			status = upstream.status;

			// Pass provider headers such as retry-after back, so clients can back off on 429s.
			res.status(upstream.status);
			for (const [name, value] of upstream.headers) {
				if (!STRIP_RESPONSE_HEADERS.has(name)) res.setHeader(name, value);
			}
			if (!upstream.headers.has("content-type")) res.setHeader("Content-Type", "application/json");
			if (!upstream.body) {
				res.end();
				return;
			}
			const scan = createUsageScanner(upstream.headers.get("content-type"));
			scanner = scan;
			const collector = createReplyCollector(upstream.headers.get("content-type"));
			replyCollector = collector;
			const tap = new Transform({
				transform(chunk, _encoding, done) {
					scan.push(chunk);
					collector.push(chunk);
					done(null, chunk);
				},
			});
			await pipeline(Readable.fromWeb(upstream.body as ReadableStream), tap, res);
		} catch (err: any) {
			const clientLeftAfterReply = err.code === PREMATURE_CLOSE_CODE && replyCollector?.streamEnded === true;
			if (!clientLeftAfterReply) {
				failure = err.message;
				console.error(`[llm-proxy] upstream error for job ${jobId}: ${err.message}`);
			}
			if (res.headersSent) res.destroy();
			else res.status(502).json({ error: "upstream unreachable", detail: err.message });
		} finally {
			const usage: LlmUsage = scanner?.finish() ?? { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
			const record: LlmCallRecord = {
				role,
				model: model.name,
				startedAt: new Date(started).toISOString(),
				latencyMs: Date.now() - started,
				...usage,
				...callCost(model, usage),
				status,
			};
			await logCall(redis, jobId, record).catch((err) => console.error(`[llm-proxy] could not log call for job ${jobId}: ${err.message}`));
			const reply = replyCollector?.finish() ?? { text: "", toolCalls: [] };
			await callTrace
				.append(jobId, count, record, requestBody, reply, failure)
				.catch((err) => console.error(`[llm-proxy] could not trace call for job ${jobId}: ${err.message}`));
		}
	});

	return router;
}
