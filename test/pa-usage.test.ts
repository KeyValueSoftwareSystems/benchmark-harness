import assert from "node:assert/strict";
import test from "node:test";
import { sumUsage, type CallUsage } from "../src/pa/grading/score.ts";
import { chat, ChatApi } from "../src/shared/chat.ts";
import type { ModelConfig } from "../src/shared/types.ts";

const call = (over: Partial<CallUsage> = {}): CallUsage => ({
	inputTokens: 100,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 10,
	costUsd: 0.5,
	costUnknown: false,
	...over,
});

test("sumUsage adds up the cache fields alongside the token and cost fields", () => {
	const usage = sumUsage([call({ inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 20 }), call({ inputTokens: 50, cacheWriteTokens: 5 })]);
	assert.deepEqual(usage, {
		calls: 2,
		inputTokens: 1050,
		cacheReadTokens: 900,
		cacheWriteTokens: 25,
		outputTokens: 20,
		costUsd: 1,
		costUnknown: false,
	});
});

test("sumUsage with no calls gives zeros and no provider cost", () => {
	assert.deepEqual(sumUsage([]), { calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, costUsd: 0, costUnknown: false });
});

test("sumUsage sums the provider cost only when every call reported one", () => {
	const all = sumUsage([call({ providerCostUsd: 0.25 }), call({ providerCostUsd: 0.5 })]);
	assert.equal(all.providerCostUsd, 0.75);

	const partial = sumUsage([call({ providerCostUsd: 0.25 }), call()]);
	assert.equal("providerCostUsd" in partial, false);
});

test("sumUsage marks the side cost unknown when any call had no price", () => {
	assert.equal(sumUsage([call(), call({ costUnknown: true })]).costUnknown, true);
	assert.equal(sumUsage([call(), call({ costUnknown: undefined })]).costUnknown, false);
});

test("sumUsage rounds the cost to a millionth of a dollar", () => {
	assert.equal(sumUsage([call({ costUsd: 0.1234567 }), call({ costUsd: 0.0000004 })]).costUsd, 0.123457);
});

/** Routes global fetch to a canned JSON body, and records the request URL. */
function stubFetch(body: unknown): { urls: string[] } {
	const seen = { urls: [] as string[] };
	globalThis.fetch = (async (url: string | URL | Request) => {
		seen.urls.push(String(url));
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	return seen;
}

const originalFetch = globalThis.fetch;
test.afterEach(() => {
	globalThis.fetch = originalFetch;
});

const openAiModel: ModelConfig = { name: "m", baseUrl: "https://llm.test/v1", apiKey: "k", api: ChatApi.openai, modelId: "gpt-test" };
const anthropicModel: ModelConfig = { name: "a", baseUrl: "https://llm.test", apiKey: "k", api: ChatApi.anthropic, modelId: "claude-test" };

test("chat returns the OpenAI reply text with its cached prompt tokens as usage", async () => {
	const seen = stubFetch({
		choices: [{ message: { content: "hello" } }],
		usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } },
	});
	const reply = await chat(openAiModel, [{ role: "user", content: "hi" }]);
	assert.equal(seen.urls[0], "https://llm.test/v1/chat/completions");
	assert.deepEqual(reply, {
		text: "hello",
		usage: { inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0, outputTokens: 20 },
	});
});

test("chat returns the Anthropic reply text with cache read and write tokens as usage", async () => {
	stubFetch({
		content: [{ type: "text", text: "hello" }],
		usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 3 },
	});
	const reply = await chat(anthropicModel, [{ role: "user", content: "hi" }]);
	assert.deepEqual(reply, {
		text: "hello",
		usage: { inputTokens: 1050, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 3 },
	});
});

test("chat leaves usage undefined when the response carries none", async () => {
	stubFetch({ choices: [{ message: { content: "hello" } }] });
	const reply = await chat(openAiModel, [{ role: "user", content: "hi" }]);
	assert.deepEqual(reply, { text: "hello", usage: undefined });
});
