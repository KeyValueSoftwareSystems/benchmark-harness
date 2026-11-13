import { chat } from "../shared/chat.ts";
import type { ModelConfig } from "../shared/types.ts";
import type { ModelMetrics } from "./metrics.ts";
import type { Narrator } from "./generate.ts";

const NARRATIVE_TIMEOUT_MS = 60_000;

/**
 * Asks a chat model to write a short comparison. It only ever sees the computed metrics, and is told not to introduce
 * numbers. Any failure returns undefined (the report is simply built without a narrative).
 */
export function narrateWithModel(model: ModelConfig): Narrator {
	return async (metrics: ModelMetrics[]) => {
		try {
			const text = await chat(
				model,
				[
					{ role: "system", content: "You write 3-4 plain sentences summarising benchmark results for engineers. Use only the numbers given. Never invent figures." },
					{ role: "user", content: JSON.stringify(metrics) },
				],
				{ timeoutMs: NARRATIVE_TIMEOUT_MS },
			);
			return text.trim() || undefined;
		} catch (err) {
			console.error(`[reports] narrative model call failed: ${err instanceof Error ? err.name : "error"}`);
			return undefined;
		}
	};
}
