import assert from "node:assert/strict";
import test from "node:test";
import { buildHermesConfig, HERMES_API_PORT } from "../src/pa/hermes-config/index.ts";

const base = { llmBaseUrl: "http://api:3000/llm/v1", llmApi: "openai-completions", services: [{ name: "gmail", port: 9100 }, { name: "todo", port: 9101 }] };

test("maps each proxy API format to a Hermes api_mode", () => {
	const apiModes = ["openai-completions", "openai-responses", "anthropic-messages"].map(
		(llmApi) => (buildHermesConfig({ ...base, llmApi }) as any).model.api_mode,
	);
	assert.deepEqual(apiModes, ["chat_completions", "codex_responses", "anthropic_messages"]);
});

test("rejects an API format Hermes has no transport for", () => {
	assert.throws(() => buildHermesConfig({ ...base, llmApi: "bedrock" }), /no Hermes api_mode/);
});

test("registers only the world's services as MCP servers", () => {
	const config = buildHermesConfig(base) as any;
	assert.deepEqual(config.mcp_servers, {
		gmail: { url: "http://localhost:9100/mcp" },
		todo: { url: "http://localhost:9101/mcp" },
	});
});

test("keeps the model key out of the config", () => {
	const text = JSON.stringify(buildHermesConfig(base));
	assert.equal((buildHermesConfig(base) as any).model.key_env, "LLM_TOKEN");
	assert.ok(!/api_key|API_SERVER_KEY/.test(text));
});

test("sets the context window only when given", () => {
	assert.equal("context_length" in (buildHermesConfig(base) as any).model, false);
	assert.equal((buildHermesConfig({ ...base, contextWindow: 128000 }) as any).model.context_length, 128000);
});

test("serves the API on loopback", () => {
	const api = (buildHermesConfig(base) as any).gateway.api_server;
	assert.deepEqual([api.host, api.port, api.enabled], ["127.0.0.1", HERMES_API_PORT, true]);
});
