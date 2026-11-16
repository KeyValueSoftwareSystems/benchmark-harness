import { StringDecoder } from "node:string_decoder";
import type { ModelConfig } from "./types.ts";

/** Token counts and provider cost for one model call. */
export interface LlmUsage {
	/** ALL prompt tokens: uncached + cacheRead + cacheWrite. */
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
	/** The provider's own billed USD for the call, when its response carries one (OpenRouter `usage.cost`). */
	providerCostUsd?: number;
}

/** Usage buckets as a response reports them so far; undefined means that response has not reported the bucket. */
interface UsageBuckets {
	uncachedInput?: number;
	cacheRead?: number;
	cacheWrite?: number;
	output?: number;
	providerCostUsd?: number;
}

/** A non-streamed body is scanned for usage only up to this size; larger ones are still passed through untouched. */
const USAGE_SCAN_MAX_CHARS = 16 * 1024 * 1024;
const SSE_DATA_PREFIX = "data:";
const TOKENS_PER_PRICE_UNIT = 1_000_000;

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Buckets from one usage object. OpenAI chat and OpenAI Responses count cached tokens inside the prompt total;
 * Anthropic reports them next to the uncached input.
 */
function bucketsFromUsage(u: Record<string, any>): UsageBuckets {
	const buckets: UsageBuckets = { providerCostUsd: count(u.cost) };
	if (u.prompt_tokens !== undefined || u.input_tokens_details !== undefined) {
		const total = count(u.prompt_tokens) ?? count(u.input_tokens);
		const details = u.prompt_tokens_details ?? u.input_tokens_details;
		buckets.cacheRead = count(details?.cached_tokens) ?? 0;
		buckets.cacheWrite = count(details?.cache_write_tokens) ?? 0;
		if (total !== undefined) buckets.uncachedInput = Math.max(0, total - buckets.cacheRead - buckets.cacheWrite);
		buckets.output = count(u.completion_tokens) ?? count(u.output_tokens);
	} else {
		buckets.uncachedInput = count(u.input_tokens);
		buckets.cacheRead = count(u.cache_read_input_tokens);
		buckets.cacheWrite = count(u.cache_creation_input_tokens);
		buckets.output = count(u.output_tokens);
	}
	return buckets;
}

/**
 * Applies whatever usage one response object carries. Covers OpenAI chat completions (`usage`, the last stream
 * chunk), Anthropic messages (`usage`, `message_start.message.usage`, `message_delta.usage`) and OpenAI responses
 * (`usage`, `response.completed.response.usage`). A bucket is replaced only when the object defines it, because
 * streams send running totals and some events carry only some fields.
 */
function applyUsage(buckets: UsageBuckets, obj: unknown): void {
	if (!obj || typeof obj !== "object") return;
	const o = obj as Record<string, any>;
	for (const u of [o.usage, o.message?.usage, o.response?.usage]) {
		if (!u || typeof u !== "object") continue;
		const parsed = bucketsFromUsage(u);
		for (const key of Object.keys(parsed) as (keyof UsageBuckets)[]) {
			if (parsed[key] !== undefined) buckets[key] = parsed[key];
		}
	}
}

/** The call's usage, or undefined when no bucket was seen. Unseen buckets count as zero. */
function toLlmUsage(buckets: UsageBuckets): LlmUsage | undefined {
	if (Object.values(buckets).every((value) => value === undefined)) return undefined;
	const cacheReadTokens = buckets.cacheRead ?? 0;
	const cacheWriteTokens = buckets.cacheWrite ?? 0;
	return {
		inputTokens: (buckets.uncachedInput ?? 0) + cacheReadTokens + cacheWriteTokens,
		cacheReadTokens,
		cacheWriteTokens,
		outputTokens: buckets.output ?? 0,
		...(buckets.providerCostUsd !== undefined ? { providerCostUsd: buckets.providerCostUsd } : {}),
	};
}

/** Usage of one parsed non-streamed response body; undefined when it carries none. */
export function readUsage(body: unknown): LlmUsage | undefined {
	const buckets: UsageBuckets = {};
	applyUsage(buckets, body);
	return toLlmUsage(buckets);
}

/** Reads usage from a response body chunk by chunk, server-sent events or plain JSON. Never throws. */
export function createUsageScanner(contentType: string | null) {
	const sse = (contentType ?? "").includes("text/event-stream");
	const decoder = new StringDecoder("utf8");
	const buckets: UsageBuckets = {};
	let pending = "";
	let overflow = false;

	const scanLine = (line: string) => {
		if (!line.startsWith(SSE_DATA_PREFIX)) return;
		const data = line.slice(SSE_DATA_PREFIX.length).trim();
		if (!data || data === "[DONE]") return;
		try {
			applyUsage(buckets, JSON.parse(data));
		} catch {
			// a data line that isn't JSON carries no usage
		}
	};

	return {
		push(chunk: Buffer | string): void {
			if (overflow) return;
			pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
			if (sse) {
				const lines = pending.split(/\r?\n/);
				pending = lines.pop() ?? "";
				for (const line of lines) scanLine(line);
			} else if (pending.length > USAGE_SCAN_MAX_CHARS) {
				overflow = true;
				pending = "";
			}
		},
		/** The usage seen so far; undefined when the body carried none. */
		finish(): LlmUsage | undefined {
			pending += decoder.end();
			if (sse) scanLine(pending);
			else if (!overflow && pending) {
				try {
					applyUsage(buckets, JSON.parse(pending));
				} catch {
					// not JSON: no usage
				}
			}
			pending = "";
			return toLlmUsage(buckets);
		},
	};
}

/**
 * USD for one call from `model.cost` (per million tokens). Cached tokens use the cache prices when set and the
 * input price otherwise; unknown when the model has no prices.
 */
export function callCost(model: Pick<ModelConfig, "cost">, usage: LlmUsage): { costUsd: number; costUnknown?: boolean } {
	const prices = model.cost;
	if (!prices) return { costUsd: 0, costUnknown: true };
	const uncachedInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens);
	const cost =
		uncachedInput * prices.input +
		usage.cacheReadTokens * (prices.cacheRead ?? prices.input) +
		usage.cacheWriteTokens * (prices.cacheWrite ?? prices.input) +
		usage.outputTokens * prices.output;
	return { costUsd: cost / TOKENS_PER_PRICE_UNIT };
}
