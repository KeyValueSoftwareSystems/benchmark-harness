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
 */

import { Router } from "express";
import type { Redis } from "ioredis";
import { MODELS, JOB_TIMEOUT_MS } from "../config.ts";
import { getJob, setStatus } from "../queue/store.ts";
import { redact } from "../../shared/types.ts";

const PAA_MAX_LLM_CALLS = Number(process.env.PAA_MAX_LLM_CALLS ?? 10_000);

/** API formats the proxy can forward: the model is named in the body and auth is a single header. */
export const PROXY_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

/** Headers that must not be forwarded upstream. */
const STRIP_HEADERS = new Set(["host", "content-length", "authorization", "x-api-key", "connection"]);

/** Redis key for a job's LLM token. */
const tokenKey = (token: string) => `llm-token:${token}`;
/** Redis key for a job's LLM call count. */
const callCountKey = (jobId: string) => `llm-calls:${jobId}`;

/**
 * Store a job-scoped LLM token in Redis.  Called by the benchmark handler
 * when a job starts so the proxy can validate incoming requests.
 */
export async function storeLlmToken(redis: Redis, token: string, jobId: string): Promise<void> {
	const ttl = Math.ceil(JOB_TIMEOUT_MS / 1000) + 300; // job timeout + 5 min buffer
	await redis.set(tokenKey(token), jobId, "EX", ttl);
}

/** Remove a job's LLM token (cleanup). */
export async function removeLlmToken(redis: Redis, token: string): Promise<void> {
	await redis.del(tokenKey(token));
}

/** Extract the job-scoped token from either Authorization: Bearer or x-api-key. */
function extractToken(req: { headers: Record<string, any> }): string {
	const auth = (req.headers.authorization ?? "") as string;
	if (auth.startsWith("Bearer ")) return auth.slice(7);
	const xApiKey = req.headers["x-api-key"];
	return typeof xApiKey === "string" ? xApiKey : "";
}

export function llmRouter(redis: Redis): Router {
	const router = Router();

	router.all("/llm/v1/{*path}", async (req, res) => {
		const token = extractToken(req);
		if (!token) {
			res.status(401).json({ error: "missing auth token (send Authorization: Bearer or x-api-key)" });
			return;
		}

		const jobId = await redis.get(tokenKey(token));
		if (!jobId) {
			res.status(403).json({ error: "invalid or expired token" });
			return;
		}

		const count = await redis.incr(callCountKey(jobId));
		if (count > PAA_MAX_LLM_CALLS) {
			const errMsg = `LLM call limit exceeded (${PAA_MAX_LLM_CALLS}). Job ${jobId} has made ${count} calls.`;
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
			fwdHeaders["x-api-key"] = model.apiKey;
		} else {
			fwdHeaders["authorization"] = `Bearer ${model.apiKey}`;
		}

		// Replace the model field in the body with the real model ID.
		const body = req.body && typeof req.body === "object"
			? JSON.stringify({ ...req.body, model: model.modelId })
			: undefined;

		try {
			console.error(`[llm-proxy] job=${jobId} ${req.method} /${subpath} model=${redact(model).name} calls=${count}`);
			const upstream = await fetch(upstreamUrl, {
				method: req.method,
				headers: fwdHeaders,
				body: req.method !== "GET" ? body : undefined,
			});

			const data = await upstream.text();
			res.status(upstream.status)
				.set("Content-Type", upstream.headers.get("Content-Type") ?? "application/json")
				.send(data);
		} catch (err: any) {
			console.error(`[llm-proxy] upstream error for job ${jobId}: ${err.message}`);
			res.status(502).json({ error: "upstream unreachable", detail: err.message });
		}
	});

	return router;
}
