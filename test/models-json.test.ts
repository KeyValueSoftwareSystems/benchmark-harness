import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { writeModelsJson } from "../src/agent/config.ts";
import type { ModelConfig } from "../src/shared/types.ts";

const base: ModelConfig = { name: "m", baseUrl: "http://x/v1", apiKey: "k", api: "openai-completions", modelId: "m-1" };

async function modelEntry(model: ModelConfig) {
	const dir = await writeModelsJson(model);
	const json = JSON.parse(await readFile(path.join(dir, "models.json"), "utf8"));
	return Object.values(json.providers as Record<string, { models: Record<string, unknown>[] }>)[0].models[0];
}

test("a configured price is passed to pi so runs report a cost", async () => {
	const entry = await modelEntry({ ...base, cost: { input: 0.14, output: 0.28 } });
	assert.deepEqual(entry.cost, { input: 0.14, output: 0.28, cacheRead: 0, cacheWrite: 0 });
});

test("cache prices are kept when given", async () => {
	const entry = await modelEntry({ ...base, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } });
	assert.deepEqual(entry.cost, { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 });
});

test("without a price the model entry has no cost key", async () => {
	assert.equal("cost" in (await modelEntry(base)), false);
});
