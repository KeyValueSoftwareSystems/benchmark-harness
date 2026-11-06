export interface ModelConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	modelId: string;
	/** USD per million tokens. Without it pi cannot price the model, so runs report a cost of 0. */
	cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** Model limits for harnesses that can't look the model up themselves (the PA assistant sees it as `proxy-model`). */
	contextWindow?: number;
	maxTokens?: number;
}

export type ReplicaStatus = "idle" | "running" | "done" | "error";

export const redact = ({ apiKey: _apiKey, ...rest }: ModelConfig) => rest;

export type JobStatus = "queued" | "provisioning" | "running" | "done" | "error" | "cancelled";

export interface Job {
	id: string;
	benchmark: string;
	prompt: string;
	/** Model name; resolved against MODELS in the API so no keys are stored with the job. */
	model: string;
	/** Benchmark-specific input, e.g. which challenge to run. */
	params?: Record<string, string>;
	status: JobStatus;
	error?: string;
	createdAt: string;
}
