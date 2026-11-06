import type { ModelConfig } from "../shared/types.ts";
import type { ModelMetrics } from "./metrics.ts";
import type { Narrator } from "./generate.ts";

/**
 * Asks an OpenAI-compatible chat model to write a short comparison. It only ever sees the computed metrics, and is told
 * not to introduce numbers. Any failure returns undefined (the report is simply built without a narrative).
 */
export function narrateWithModel(model: ModelConfig): Narrator {
	return async (metrics: ModelMetrics[]) => {
		try {
			const res = await fetch(`${model.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
				body: JSON.stringify({
					model: model.modelId,
					messages: [
						{ role: "system", content: "You write 3-4 plain sentences summarising benchmark results for engineers. Use only the numbers given. Never invent figures." },
						{ role: "user", content: JSON.stringify(metrics) },
					],
				}),
				signal: AbortSignal.timeout(60_000),
			});
			if (!res.ok) return undefined;
			const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
			return body.choices?.[0]?.message?.content?.trim() || undefined;
		} catch (err) {
			console.error(`[reports] narrative model call failed: ${err instanceof Error ? err.name : "error"}`);
			return undefined;
		}
	};
}
