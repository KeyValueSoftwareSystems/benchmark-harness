import { parseArgs } from "node:util";
import type { ModelConfig } from "../shared/types.ts";
import { generateReport } from "./generate.ts";
import { generatePaReport } from "./pa/generate.ts";
import { narrateWithModel } from "./narrative.ts";

const { values } = parseArgs({
	options: {
		benchmark: { type: "string" },
		models: { type: "string" },
		// PA-specific: one model, multiple assistants
		model: { type: "string" },
		assistants: { type: "string" },
	},
});

if (!values.benchmark) {
	console.error("usage: report --benchmark <name> --models <model,model,...>");
	console.error("   PA: report --benchmark pa --model <model> --assistants openclaw,<other>");
	process.exit(2);
}

// Optional: one model config (JSON) to write the narrative. The reports service never gets the api's MODELS (keys).
const narrator = process.env.NARRATIVE_MODEL ? narrateWithModel(JSON.parse(process.env.NARRATIVE_MODEL) as ModelConfig) : undefined;

try {
	if (values.benchmark === "pa") {
		if (!values.model || !values.assistants) {
			console.error("PA usage: report --benchmark pa --model <model> --assistants openclaw,<other>");
			process.exit(2);
		}
		const assistants = values.assistants.split(",").map((a) => a.trim()).filter(Boolean);
		const out = await generatePaReport({
			model: values.model,
			assistants,
			resultsDir: process.env.RESULTS_DIR ?? "/data/results",
			reportsDir: process.env.REPORTS_DIR ?? "/data/reports",
			resourcesDir: process.env.RESOURCES_DIR ?? "/data/resources",
		});
		console.log(out.htmlPath);
		console.log(out.jsonPath);
	} else {
		const models = values.models?.split(",").map((m) => m.trim()).filter(Boolean) ?? [];
		if (!models.length) {
			console.error("usage: report --benchmark <name> --models <model,model,...>");
			process.exit(2);
		}
		const out = await generateReport({
			benchmark: values.benchmark,
			models,
			resultsDir: process.env.RESULTS_DIR ?? "/data/results",
			reportsDir: process.env.REPORTS_DIR ?? "/data/reports",
			narrate: narrator,
		});
		console.log(out.htmlPath);
		console.log(out.jsonPath);
	}
} catch (err) {
	console.error(`[reports] ${err instanceof Error ? err.message : err}`);
	process.exit(1);
}
