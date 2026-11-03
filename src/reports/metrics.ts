import type { ModelFile } from "../shared/results.ts";

export interface ModelMetrics {
	model: string;
	solved: number;
	total: number;
	/** Percent, one decimal. */
	successRate: number;
	/** Median wall time of solved runs; null when nothing was solved. */
	medianSolveMs: number | null;
	/** Mean cost per run (every run counts, solved or not); null with no runs. */
	avgCostUsd: number | null;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A run is solved only when the benchmark reported `correct: true`; runs without a verdict count in the total. */
export function computeMetrics(file: ModelFile): ModelMetrics {
	const total = file.runs.length;
	const solvedRuns = file.runs.filter((r) => r.correct === true);
	return {
		model: file.model,
		solved: solvedRuns.length,
		total,
		successRate: total ? round((solvedRuns.length / total) * 100, 1) : 0,
		medianSolveMs: median(solvedRuns.map((r) => r.metrics.durationMs)),
		avgCostUsd: total ? round(file.runs.reduce((sum, r) => sum + r.metrics.costUsd, 0) / total, 4) : null,
	};
}
