import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readModelFile } from "../api/db/modelFiles.ts";
import type { ModelFile } from "../shared/results.ts";
import { slug } from "../shared/results.ts";
import { computeMetrics, type ModelMetrics } from "./metrics.ts";
import { type NetraSummary, summarizeNetra } from "./netra.ts";
import { renderReport } from "./render.ts";

export type Narrator = (metrics: ModelMetrics[]) => Promise<string | undefined>;

export interface GenerateArgs {
	benchmark: string;
	models: string[];
	resultsDir: string;
	reportsDir: string;
	/** ISO time; only runs created at or after it are included. */
	since?: string;
	narrate?: Narrator;
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Distinct challenges across the chosen models; benchmarks without challenges fall back to the largest run count. */
function challengeCount(files: ModelFile[]): number {
	const challenges = new Set(files.flatMap((f) => f.runs.map((r) => r.challenge).filter((c): c is string => !!c)));
	return challenges.size || Math.max(0, ...files.map((f) => f.runs.length));
}

function describeConditions(files: ModelFile[]): string {
	const runs = files.flatMap((f) => f.runs);
	if (new Set(runs.map((r) => JSON.stringify(r.conditions))).size > 1) return "Mixed run conditions";
	const c = runs[0]?.conditions ?? {};
	const turns = typeof c.maxTurns === "number" ? `${c.maxTurns} turns max` : "unlimited turns";
	const limit = typeof c.jobTimeoutMs === "number" ? `${Math.round(c.jobTimeoutMs / 60_000)} min limit` : "no time limit";
	return `Same tools · ${turns} · ${limit}`;
}

/** Builds one HTML report (plus a JSON sidecar with the computed numbers) from the chosen models' result files. */
export async function generateReport(args: GenerateArgs): Promise<{ id: string; htmlPath: string; jsonPath: string }> {
	const files: ModelFile[] = [];
	for (const model of args.models) {
		const file = await readModelFile(args.resultsDir, args.benchmark, model);
		if (file && args.since) file.runs = file.runs.filter((r) => r.createdAt >= args.since!);
		if (!file?.runs.length) throw new Error(`no results for model "${model}" on benchmark "${args.benchmark}"`);
		files.push(file);
	}
	const metrics = files.map(computeMetrics);
	const netra = files.map(summarizeNetra).filter((n): n is NetraSummary => n !== null);
	const narrative = await args.narrate?.(metrics).catch((err) => (console.error(`[reports] narrative failed: ${err}`), undefined));
	const count = challengeCount(files);
	const conditions = describeConditions(files);
	const id = `${slug(args.benchmark)}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 4)}`;

	await mkdir(args.reportsDir, { recursive: true });
	const htmlPath = path.join(args.reportsDir, `${id}.html`);
	const jsonPath = path.join(args.reportsDir, `${id}.json`);
	await writeFile(
		htmlPath,
		renderReport({ title: `${titleCase(args.benchmark)} Benchmark Results`, benchmark: args.benchmark, challengeCount: count, conditions, models: metrics, netra, narrative }),
	);
	await writeFile(
		jsonPath,
		JSON.stringify({ id, benchmark: args.benchmark, generatedAt: new Date().toISOString(), challengeCount: count, conditions, models: metrics, netra, narrative: narrative ?? null }, null, 2),
	);
	return { id, htmlPath, jsonPath };
}
