import assert from "node:assert/strict";
import test from "node:test";
import { enabledToolNames } from "../src/pa/paa-info/openclaw-tools.ts";

test("lists the sorted, de-duplicated tool names of enabled plugins only", () => {
	const json = JSON.stringify({
		plugins: [
			{ id: "browser", enabled: true, toolNames: ["browser", "canvas"] },
			{ id: "memory", enabled: true, toolNames: ["memory_search", "browser"] },
			{ id: "a2a", enabled: false, toolNames: ["a2a_send"] },
			{ id: "openai", enabled: true },
		],
	});
	assert.deepEqual(enabledToolNames(json), ["browser", "canvas", "memory_search"]);
});
