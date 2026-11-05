import { parseArgs } from "node:util";
import type { ModelConfig } from "../shared/types.ts";
import { generateReport } from "./generate.ts";
import { narrateWithModel } from "./narrative.ts";

const { values } = parseArgs({ options: { benchmark: { type: "string" }, models: { type: "string" }, since: { type: "string" } } });
const models = values.models?.split(",").map((m) => m.trim()).filter(Boolean) ?? [];
if (!values.benchmark || !models.length) {
	console.error("usage: report --benchmark <name> --models <model,model,...>");
	process.exit(2);
}

// Optional: one model config (JSON) to write the narrative. The reports service never gets the api's MODELS (keys).
const narrator = process.env.NARRATIVE_MODEL ? narrateWithModel(JSON.parse(process.env.NARRATIVE_MODEL) as ModelConfig) : undefined;

try {
	const out = await generateReport({
		benchmark: values.benchmark,
		models,
		resultsDir: process.env.RESULTS_DIR ?? "/data/results",
		reportsDir: process.env.REPORTS_DIR ?? "/data/reports",
		since: values.since && new Date(values.since).toISOString(),
		narrate: narrator,
	});
	console.log(out.htmlPath);
	console.log(out.jsonPath);
} catch (err) {
	console.error(`[reports] ${err instanceof Error ? err.message : err}`);
	process.exit(1);
}
