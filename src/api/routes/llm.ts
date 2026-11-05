/**
 * LLM proxy: lets job containers call model APIs without holding real keys.
 *
 * Each container gets a job-scoped bearer token. The proxy validates it,
 * looks up the job's model, and forwards the request with the real API key.
 * The real key is never logged; use `redact()` for any model-related logging.
 */

import { Router } from "express";
import type { Redis } from "ioredis";
import { MODELS, JOB_TIMEOUT_MS } from "../config.ts";
import { getJob, setStatus } from "../queue/store.ts";
import { redact } from "../../shared/types.ts";

const PAA_MAX_LLM_CALLS = Number(process.env.PAA_MAX_LLM_CALLS ?? 10_000);

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

export function llmRouter(redis: Redis): Router {
	const router = Router();

	router.post("/llm/v1/chat/completions", async (req, res) => {
		const auth = req.headers.authorization ?? "";
		const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
		if (!token) {
			res.status(401).json({ error: "missing bearer token" });
			return;
		}

		const jobId = await redis.get(tokenKey(token));
		if (!jobId) {
			res.status(403).json({ error: "invalid or expired token" });
			return;
		}

		// Enforce call limit as a backstop
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

		// Replace the model field in the body with the real model ID
		const body = { ...req.body, model: model.modelId };

		try {
			console.error(`[llm-proxy] job=${jobId} model=${redact(model).name} calls=${count}`);
			const upstream = await fetch(`${model.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${model.apiKey}`,
				},
				body: JSON.stringify(body),
			});

			const data = await upstream.text();
			res.status(upstream.status).set("Content-Type", upstream.headers.get("Content-Type") ?? "application/json").send(data);
		} catch (err: any) {
			console.error(`[llm-proxy] upstream error for job ${jobId}: ${err.message}`);
			res.status(502).json({ error: "upstream unreachable", detail: err.message });
		}
	});

	return router;
}
