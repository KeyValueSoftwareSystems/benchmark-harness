#!/usr/bin/env node
/**
 * Writes Hermes' `config.yaml` for one PA job: the benchmark LLM proxy as a custom model
 * endpoint, the world's mock services as MCP servers, and the local API server.
 * Nothing else is configured, so Hermes runs with its default toolset.
 *
 * Secrets stay out of the file: the model key is read from `LLM_TOKEN` and the API
 * server key from `API_SERVER_KEY`, both set in the container's environment.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { MCP_PATH } from "../constants.ts";

export const HERMES_API_PORT = 8642;
export const HERMES_API_HOST = "127.0.0.1";
/** The model name Hermes advertises on `/v1/models` and the chat adapter sends. */
export const HERMES_MODEL_NAME = "hermes-agent";

const PROXY_MODEL_ID = "proxy-model";
const MODEL_KEY_ENV = "LLM_TOKEN";

/** Hermes' `api_mode` values, keyed by the harness's model API names. */
const HERMES_API_MODE: Record<string, string> = {
	"openai-completions": "chat_completions",
	"openai-responses": "codex_responses",
	"anthropic-messages": "anthropic_messages",
};

export interface HermesConfigInput {
	/** The LLM proxy URL for the model's API format. */
	llmBaseUrl: string;
	/** The model's API format (a key of `HERMES_API_MODE`). */
	llmApi: string;
	contextWindow?: number;
	/** The world's mock services, each served as MCP on `localhost:<port>`. */
	services: { name: string; port: number }[];
}

export function buildHermesConfig(input: HermesConfigInput): object {
	const apiMode = HERMES_API_MODE[input.llmApi];
	if (!apiMode) throw new Error(`model api ${input.llmApi} has no Hermes api_mode`);

	const mcpServers = Object.fromEntries(
		input.services.map(({ name, port }) => [name, { url: `http://localhost:${port}${MCP_PATH}` }]),
	);

	return {
		model: {
			default: PROXY_MODEL_ID,
			provider: "custom",
			base_url: input.llmBaseUrl,
			key_env: MODEL_KEY_ENV,
			api_mode: apiMode,
			...(input.contextWindow ? { context_length: input.contextWindow } : {}),
		},
		mcp_servers: mcpServers,
		gateway: {
			api_server: { enabled: true, host: HERMES_API_HOST, port: HERMES_API_PORT, model_name: HERMES_MODEL_NAME },
		},
	};
}

function requiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

if (import.meta.main) {
	const world = YAML.parse(readFileSync(path.join(requiredEnv("WORLD_DIR"), "world.yaml"), "utf8"));
	const config = buildHermesConfig({
		llmBaseUrl: requiredEnv("LLM_BASE_URL"),
		llmApi: requiredEnv("LLM_API"),
		contextWindow: process.env.LLM_CONTEXT_WINDOW ? Number(process.env.LLM_CONTEXT_WINDOW) : undefined,
		services: world.services ?? [],
	});
	writeFileSync(path.join(requiredEnv("HERMES_HOME"), "config.yaml"), YAML.stringify(config));
}
