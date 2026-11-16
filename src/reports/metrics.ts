import type { ModelFile, RunRecord } from "../shared/results.ts";

export interface ModelMetrics {
	model: string;
	solved: number;
	total: number;
	/** Percent, one decimal. */
	successRate: number;
	/** Median wall time of solved runs; null when nothing was solved. */
	medianSolveMs: number | null;
	/** Mean cost per run that reported usage (solved or not); null when none did. */
	avgCostUsd: number | null;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

function median(values: number[]): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Re-runs of one challenge in one trial count once (the latest wins); each trial of a challenge counts on its own.
 * Runs without a challenge are each their own attempt.
 */
export function latestPerChallengeTrial(runs: RunRecord[]): RunRecord[] {
	const latest = new Map<string, RunRecord>();
	for (const run of runs) {
		const key = run.challenge === null ? `job:${run.jobId}` : JSON.stringify([run.challenge, run.trial]);
		const current = latest.get(key);
		if (!current || run.createdAt >= current.createdAt) latest.set(key, run);
	}
	return [...latest.values()];
}

/** A run is solved only when the benchmark reported `correct: true`; runs without a verdict count in the total. */
export function computeMetrics(file: ModelFile): ModelMetrics {
	const runs = latestPerChallengeTrial(file.runs);
	const total = runs.length;
	const solvedRuns = runs.filter((r) => r.correct === true);
	// Runs that never reported (zero turns: provisioning errors, lost results) have no cost to average.
	const reported = runs.filter((r) => r.metrics.turns > 0);
	return {
		model: file.model,
		solved: solvedRuns.length,
		total,
		successRate: total ? round((solvedRuns.length / total) * 100, 1) : 0,
		medianSolveMs: median(solvedRuns.map((r) => r.metrics.durationMs)),
		avgCostUsd: reported.length ? round(reported.reduce((sum, r) => sum + r.metrics.costUsd, 0) / reported.length, 4) : null,
	};
}
