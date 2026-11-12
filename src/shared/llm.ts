import type { ModelConfig } from "./types.ts";

export interface ChatMessage {
	role: "system" | "user";
	content: string;
}

/**
 * One call to an OpenAI-compatible chat endpoint. Any failure returns undefined; only the error's name is logged,
 * never its message (it can echo request details).
 */
export async function chatComplete(model: ModelConfig, messages: ChatMessage[], timeoutMs = 60_000): Promise<string | undefined> {
	try {
		const res = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
			body: JSON.stringify({ model: model.modelId, messages }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) return undefined;
		const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
		return body.choices?.[0]?.message?.content?.trim() || undefined;
	} catch (err) {
		console.error(`[llm] chat call failed: ${err instanceof Error ? err.name : "error"}`);
		return undefined;
	}
}
