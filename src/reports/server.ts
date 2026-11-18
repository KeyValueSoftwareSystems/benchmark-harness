import type { ModelConfig } from "../shared/types.ts";
import { createReportsApp } from "./app.ts";
import { generateReport } from "./generate.ts";
import { narrateWithModel } from "./narrative.ts";

// Optional: one model config (JSON) to write the narrative. This service never gets the api's MODELS (keys).
const narrate = process.env.NARRATIVE_MODEL ? narrateWithModel(JSON.parse(process.env.NARRATIVE_MODEL) as ModelConfig) : undefined;
const port = Number(process.env.PORT ?? 3001);

createReportsApp({
	generate: generateReport,
	reportsDir: process.env.REPORTS_DIR ?? "/data/reports",
	resultsDir: process.env.RESULTS_DIR ?? "/data/results",
	narrate,
}).listen(port, () => console.error(`[reports] listening on ${port}`));
