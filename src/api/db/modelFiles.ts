import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelFile, RunRecord } from "../../shared/results.ts";
import { slug } from "../../shared/results.ts";

const filePath = (dir: string, benchmark: string, model: string) => path.join(dir, slug(benchmark), `${slug(model)}.json`);

/** Writes to the same file are chained so concurrent jobs of one model never clobber each other. */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(file: string, task: () => Promise<T>): Promise<T> {
	const next = (queues.get(file) ?? Promise.resolve()).catch(() => undefined).then(task);
	queues.set(file, next);
	return next;
}

/** Entries written before a field existed get its default, so they compare equal to the SQLite row. */
const withDefaults = (run: RunRecord): RunRecord => ({ ...run, assistant: run.assistant ?? null });

export async function readModelFile(dir: string, benchmark: string, model: string): Promise<ModelFile | undefined> {
	try {
		const file = JSON.parse(await readFile(filePath(dir, benchmark, model), "utf8")) as ModelFile;
		return { ...file, runs: file.runs.map(withDefaults) };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

async function mutate(dir: string, run: RunRecord, edit: (file: ModelFile) => void): Promise<void> {
	const file = filePath(dir, run.benchmark, run.model);
	await serialized(file, async () => {
		const current = (await readModelFile(dir, run.benchmark, run.model)) ?? {
			benchmark: run.benchmark,
			model: run.model,
			modelId: run.modelId,
			runs: [],
		};
		edit(current);
		await mkdir(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		await writeFile(tmp, JSON.stringify(current, null, 2));
		await rename(tmp, file);
	});
}

/** Adds the run, or replaces the entry of the same job (a re-run: the latest attempt wins). */
export const upsertRunInFile = (dir: string, run: RunRecord) =>
	mutate(dir, run, (file) => {
		const i = file.runs.findIndex((r) => r.jobId === run.jobId);
		if (i >= 0) file.runs[i] = run;
		else file.runs.push(run);
	});

/** Updates an existing entry (e.g. with Netra data), unless a newer attempt of the job has replaced it meanwhile. */
export const updateRunInFile = (dir: string, run: RunRecord) =>
	mutate(dir, run, (file) => {
		const i = file.runs.findIndex((r) => r.jobId === run.jobId);
		if (i >= 0 && file.runs[i].sessionId === run.sessionId) file.runs[i] = run;
	});
