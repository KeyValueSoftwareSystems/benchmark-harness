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
