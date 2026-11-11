import type { ModelConfig } from "./types.ts";

/** One non-streamed chat call to a configured model, in its own API format (`openai-completions` or `anthropic-messages`). */

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatOptions {
	temperature?: number;
	maxTokens?: number;
	timeoutMs?: number;
}

export const ChatApi = { openai: "openai-completions", anthropic: "anthropic-messages" } as const;
export const CHAT_APIS: ReadonlySet<string> = new Set(Object.values(ChatApi));

const DEFAULT_TIMEOUT_MS = 120_000;
/** Anthropic requires max_tokens. */
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
const ANTHROPIC_VERSION = "2023-06-01";

/** Errors carry the status only: never the key, the request or the body. */
export class ChatError extends Error {}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new ChatError(`model call failed with status ${res.status}`);
	return res.json();
}

/** The reply's text. Throws `ChatError` (or an abort/network error) when the call fails. */
export async function chat(model: ModelConfig, messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (model.api === ChatApi.anthropic) {
		const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
		const base = model.baseUrl.replace(/\/$/, "").replace(/\/v1$/, "");
		const body = (await post(
			`${base}/v1/messages`,
			{ "x-api-key": model.apiKey, "anthropic-version": ANTHROPIC_VERSION },
			{
				model: model.modelId,
				...(system && { system }),
				messages: messages.filter((m) => m.role !== "system"),
				max_tokens: options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
				...(options.temperature !== undefined && { temperature: options.temperature }),
			},
			timeoutMs,
		)) as { content?: { type: string; text?: string }[] };
		return (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
	}
	if (model.api !== ChatApi.openai) throw new ChatError(`unsupported model api ${model.api}`);
	const body = (await post(
		`${model.baseUrl.replace(/\/$/, "")}/chat/completions`,
		{ authorization: `Bearer ${model.apiKey}` },
		{
			model: model.modelId,
			messages,
			...(options.temperature !== undefined && { temperature: options.temperature }),
			...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
		},
		timeoutMs,
	)) as { choices?: { message?: { content?: string | null } }[] };
	return body.choices?.[0]?.message?.content ?? "";
}
