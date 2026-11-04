export interface RunMetrics {
	turns: number;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
}

/** What an agent container reports for its run; benchmark-agnostic. `outcome` is whatever `benchmark_result` carried. */
export interface ResultPayload {
	outcome: Record<string, unknown> | null;
	metrics: RunMetrics;
	sessionId?: string;
}

/** One settled job, as stored in SQLite and in the per-model JSON file. */
export interface RunRecord {
	jobId: string;
	benchmark: string;
	model: string;
	modelId: string;
	challenge: string | null;
	status: string;
	correct: boolean | null;
	outcome: Record<string, unknown> | null;
	metrics: RunMetrics;
	sessionId: string | null;
	traceIds: string[] | null;
	netraMetadata: unknown;
	conditions: Record<string, unknown>;
	createdAt: string;
	finishedAt: string;
}

export interface ModelFile {
	benchmark: string;
	model: string;
	modelId: string;
	runs: RunRecord[];
}

/** Safe file-name component: never contains a path separator or leading dots. */
export function slug(name: string): string {
	const cleaned = name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/^[.-]+|[.-]+$/g, "");
	return cleaned || "unnamed";
}
