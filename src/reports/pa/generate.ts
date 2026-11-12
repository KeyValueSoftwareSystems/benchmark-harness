/**
 * PA report generation: reads one model file, groups by assistant, renders comparison HTML + JSON sidecar.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readModelFile } from "../../api/db/modelFiles.ts";
import { slug } from "../../shared/results.ts";
import { computePaReportData, loadCalibration, type PaReportData } from "./metrics.ts";
import { renderPaReport } from "./render.ts";

export interface PaGenerateArgs {
	model: string;
	assistants: string[];
	resultsDir: string;
	reportsDir: string;
	resourcesDir: string;
}

export async function generatePaReport(args: PaGenerateArgs): Promise<{ id: string; htmlPath: string; jsonPath: string }> {
	const file = await readModelFile(args.resultsDir, "pa", args.model);
	if (!file?.runs.length) throw new Error(`no PA results for model "${args.model}"`);

	const data = computePaReportData(file, args.assistants);
	data.calibration = await loadCalibration(args.resourcesDir);

	const id = `pa-${slug(args.model)}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 4)}`;

	await mkdir(args.reportsDir, { recursive: true });
	const htmlPath = path.join(args.reportsDir, `${id}.html`);
	const jsonPath = path.join(args.reportsDir, `${id}.json`);

	await writeFile(htmlPath, renderPaReport(data));
	await writeFile(
		jsonPath,
		JSON.stringify(
			{
				id,
				benchmark: "pa",
				model: data.model,
				generatedAt: new Date().toISOString(),
				assistants: data.assistants,
				allWorlds: data.allWorlds,
				allCategories: data.allCategories,
				calibration: data.calibration,
				conditions: data.conditions,
				runWindow: data.runWindow,
			},
			null,
			2,
		),
	);

	return { id, htmlPath, jsonPath };
}
