import type { ModelFile } from "../shared/results.ts";
import { latestPerChallenge } from "./metrics.ts";

export interface NetraSummary {
	model: string;
	/** Traces behind the numbers below. */
	traces: number;
	avgLatencyMs: number | null;
	avgInputTokens: number | null;
	avgOutputTokens: number | null;
	errorTraces: number;
}

const num = (value: unknown): number | undefined => {
	const n = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
	return Number.isFinite(n) ? n : undefined;
};

const average = (values: (number | undefined)[]): number | null => {
	const present = values.filter((v): v is number => v !== undefined);
	return present.length ? Math.round((present.reduce((a, b) => a + b, 0) / present.length) * 10) / 10 : null;
};

/**
 * What the stored Netra session data says about a model's traces (the counted runs only: re-runs of a challenge
 * count once). Fields a trace lacks are left out of that average. Null when no run has Netra data.
 */
export function summarizeNetra(file: ModelFile): NetraSummary | null {
	const traces = latestPerChallenge(file.runs).flatMap((run) => {
		const list = (run.netraMetadata as { traces?: unknown } | null)?.traces;
		return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
	});
	if (!traces.length) return null;
	return {
		model: file.model,
		traces: traces.length,
		avgLatencyMs: average(traces.map((t) => num(t.latency_ms))),
		avgInputTokens: average(traces.map((t) => num(t.prompt_tokens))),
		avgOutputTokens: average(traces.map((t) => num(t.completion_tokens))),
		errorTraces: traces.filter((t) => t.has_error === true).length,
	};
}
