import assert from "node:assert/strict";
import test from "node:test";
import { callCost, createUsageScanner, readUsage } from "../src/shared/llm-usage.ts";

const sseLine = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

function scanSse(events: unknown[]) {
	const scanner = createUsageScanner("text/event-stream");
	for (const event of events) scanner.push(sseLine(event));
	return scanner.finish();
}

test("OpenAI chat JSON: cached prompt tokens are inside the prompt total", () => {
	const usage = readUsage({ usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } } });
	assert.deepEqual(usage, { inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 20 });
});

test("OpenAI chat SSE: usage comes from the last chunk and null usage on earlier chunks is ignored", () => {
	const usage = scanSse([
		{ choices: [{ delta: { content: "Hel" } }], usage: null },
		{ choices: [{ delta: { content: "lo" } }], usage: null },
		{ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 100 } } },
	]);
	assert.deepEqual(usage, { inputTokens: 120, cacheReadTokens: 100, cacheWriteTokens: 0, outputTokens: 7 });
});

test("OpenAI Responses: input_tokens_details carries the cached tokens", () => {
	const usage = readUsage({ usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 600 }, output_tokens: 5 } });
	assert.deepEqual(usage, { inputTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 0, outputTokens: 5 });
});

test("Anthropic JSON: input, cache read and cache write add up to the prompt total", () => {
	const usage = readUsage({ usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 3 } });
	assert.deepEqual(usage, { inputTokens: 1050, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 3 });
});

test("Anthropic SSE: message_delta with only output_tokens keeps the input and cache counts from message_start", () => {
	const usage = scanSse([
		{
			type: "message_start",
			message: { usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 1 } },
		},
		{ type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
	]);
	assert.deepEqual(usage, { inputTokens: 1050, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 42 });
});

test("OpenRouter usage.cost is reported as providerCostUsd", () => {
	const usage = readUsage({ usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00012 } });
	assert.equal(usage?.providerCostUsd, 0.00012);
	assert.equal(usage?.inputTokens, 10);
});

test("a response without usage reports none", () => {
	assert.equal(readUsage({ choices: [] }), undefined);
	assert.equal(scanSse([{ choices: [] }]), undefined);
});

/** Float arithmetic on per-million prices is not exact, so compare with a tolerance. */
const assertCloseTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("callCost prices cached prompt tokens at the cache read rate", () => {
	const model = { cost: { input: 0.15, output: 0.6, cacheRead: 0.003 } };
	const usage = { inputTokens: 1_000_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, outputTokens: 0 };
	const { costUsd, costUnknown } = callCost(model, usage);
	assertCloseTo(costUsd, 0.0177);
	assert.equal(costUnknown, undefined);
});

test("callCost falls back to the input rate when the model has no cache read price", () => {
	const model = { cost: { input: 0.15, output: 0.6 } };
	const usage = { inputTokens: 1_000_000, cacheReadTokens: 900_000, cacheWriteTokens: 0, outputTokens: 0 };
	assertCloseTo(callCost(model, usage).costUsd, 0.15);
});

test("callCost reports the cost unknown when the model has no prices", () => {
	const usage = { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10 };
	assert.deepEqual(callCost({}, usage), { costUsd: 0, costUnknown: true });
});
