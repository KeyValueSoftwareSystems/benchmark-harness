import { readFile } from "node:fs/promises";
import path from "node:path";

/** The four buckets a selection draws its worlds from. */
export const Bucket = { work: "work", personalLife: "personal_life", homeFamily: "home_family", selfEmployed: "self_employed" } as const;
export type Bucket = (typeof Bucket)[keyof typeof Bucket];
const BUCKETS = new Set<string>(Object.values(Bucket));

export interface SelectionTask {
	bucket: Bucket;
	split: string;
	bundle: string;
	taskId: string;
	persona: string;
	worldId: string;
	translated: boolean;
}

/** A named set of worlds; `<selectionsDir>/<name>.json` holds one. Other fields in the file are ignored. */
export interface SelectionManifest {
	name: string;
	tasks: SelectionTask[];
}

const SELECTION_NAME = /^[\w.-]+$/;

function parseManifest(value: unknown): SelectionManifest {
	const manifest = value as Partial<SelectionManifest> | null;
	if (!manifest || typeof manifest.name !== "string" || !Array.isArray(manifest.tasks)) throw new Error("selection needs a name and a tasks array");
	if (!manifest.tasks.length) throw new Error("selection has no tasks");
	const tasks = manifest.tasks as SelectionTask[];
	for (const task of tasks) {
		if (!BUCKETS.has(task.bucket)) throw new Error(`unknown bucket ${String(task.bucket)}`);
		if (typeof task.worldId !== "string") throw new Error("task has no worldId");
	}
	const worldIds = tasks.map((task) => task.worldId);
	const duplicate = worldIds.find((id, i) => worldIds.indexOf(id) !== i);
	if (duplicate !== undefined) throw new Error(`duplicate worldId ${duplicate}`);
	return { name: manifest.name, tasks };
}

/** Reads and validates a selection by name. Throws when the name is invalid, the file is missing or the manifest is malformed. */
export async function loadSelection(selectionName: string, selectionsDir: string): Promise<SelectionManifest> {
	if (!SELECTION_NAME.test(selectionName)) throw new Error(`invalid selection ${selectionName}`);
	return parseManifest(JSON.parse(await readFile(path.join(selectionsDir, `${selectionName}.json`), "utf8")));
}
