export interface ModelConfig {
	name: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	modelId: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
