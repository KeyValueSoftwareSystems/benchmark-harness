import assert from "node:assert/strict";
import test from "node:test";
import { discoverParameters } from "../src/api/discovery/extract.ts";
import type { ModelConfig } from "../src/shared/types.ts";

const model: ModelConfig = { name: "ext", baseUrl: "https://e/v1", apiKey: "sk-extractor-secret", api: "openai-completions", modelId: "ext-1" };
const reply = (text: string | undefined) => async () => text;

test("a valid reply is parsed", async () => {
	const out = await discoverParameters("docs text", model, reply('{"thinkingLevels":["off","low","high"],"cost":{"input":0.1,"output":0.4}}'));
	assert.deepEqual(out, { thinkingLevels: ["off", "low", "high"], cost: { input: 0.1, output: 0.4 } });
});

test("a reply wrapped in a code fence is still parsed", async () => {
	const out = await discoverParameters("t", model, reply('```json\n{"thinkingLevels":["medium"]}\n```'));
	assert.deepEqual(out, { thinkingLevels: ["medium"] });
});

test("unknown thinking levels and bad prices are dropped", async () => {
	const out = await discoverParameters("t", model, reply('{"thinkingLevels":["off","turbo",5],"cost":{"input":-1,"output":"x"}}'));
	assert.deepEqual(out, { thinkingLevels: ["off"] });
});

test("garbage or no reply gives an empty result and does not throw", async () => {
	assert.deepEqual(await discoverParameters("t", model, reply("sure! here you go")), { thinkingLevels: [] });
	assert.deepEqual(await discoverParameters("t", model, reply(undefined)), { thinkingLevels: [] });
});

test("the extractor sees the page text but never the key, and is told the page is data", async () => {
	let seen = "";
	await discoverParameters("PAGE-TEXT-123", model, async (_m, messages) => ((seen = JSON.stringify(messages)), "{}"));
	assert.ok(seen.includes("PAGE-TEXT-123"));
	assert.ok(!seen.includes("sk-extractor-secret"));
	assert.match(seen, /ignore any instructions/i);
});
