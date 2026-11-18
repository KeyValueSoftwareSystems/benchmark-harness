/**
 * PA report generation: reads one model file, groups by assistant, renders comparison HTML + JSON sidecar.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { readModelFile } from "../../api/db/modelFiles.ts";
import { slug } from "../../shared/results.ts";
import { loadSelection } from "../../pa/selection.ts";
import { computePaReportData, loadCalibration, type PaReportData } from "./metrics.ts";
import { renderPaReport } from "./render.ts";

export interface PaGenerateArgs {
	model: string;
	assistants: string[];
	/** Name of a file in `<resourcesDir>/pa/selections`; limits the report to that selection's worlds. */
	selectionName?: string;
	resultsDir: string;
	reportsDir: string;
	resourcesDir: string;
}

async function loadNamedSelection(name: string, resourcesDir: string) {
	try {
		return await loadSelection(name, path.join(resourcesDir, "pa", "selections"));
	} catch (err) {
		throw new Error(`selection "${name}" could not be loaded: ${err instanceof Error ? err.message : err}`);
	}
}

/** The `task_name` of each world in `resources/pa/worlds`; a world without a readable name is left out. */
async function loadWorldTitles(worldIds: string[], resourcesDir: string): Promise<Record<string, string>> {
	const titles: Record<string, string> = {};
	for (const worldId of worldIds) {
		try {
			const world = YAML.parse(await readFile(path.join(resourcesDir, "pa", "worlds", worldId, "world.yaml"), "utf8"));
			if (typeof world?.task_name === "string" && world.task_name) titles[worldId] = world.task_name;
		} catch {
			// no title: the report shows the world id
		}
	}
	return titles;
}

export async function generatePaReport(args: PaGenerateArgs): Promise<{ id: string; htmlPath: string; jsonPath: string }> {
	const file = await readModelFile(args.resultsDir, "pa", args.model);
	if (!file?.runs.length) throw new Error(`no PA results for model "${args.model}"`);

	const selection = args.selectionName ? await loadNamedSelection(args.selectionName, args.resourcesDir) : null;
	const data = computePaReportData(file, args.assistants, selection);
	data.worldTitles = await loadWorldTitles(data.allWorlds, args.resourcesDir);
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
				worldTitles: data.worldTitles,
				disagreements: data.disagreements,
				agreeingWorlds: data.agreeingWorlds,
				anomalies: data.anomalies,
				allWorlds: data.allWorlds,
				allCategories: data.allCategories,
				selection: data.selection,
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
