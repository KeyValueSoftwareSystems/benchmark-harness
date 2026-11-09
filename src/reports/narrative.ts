import { chatComplete } from "../shared/llm.ts";
import type { ModelConfig } from "../shared/types.ts";
import type { Narrator } from "./generate.ts";
import type { ModelMetrics } from "./metrics.ts";

/**
 * Asks an OpenAI-compatible chat model to write a short comparison. It only ever sees the computed metrics, and is told
 * not to introduce numbers. Any failure returns undefined (the report is simply built without a narrative).
 */
export function narrateWithModel(model: ModelConfig): Narrator {
	return (metrics: ModelMetrics[]) =>
		chatComplete(model, [
			{ role: "system", content: "You write 3-4 plain sentences summarising benchmark results for engineers. Use only the numbers given. Never invent figures." },
			{ role: "user", content: JSON.stringify(metrics) },
		]);
}
