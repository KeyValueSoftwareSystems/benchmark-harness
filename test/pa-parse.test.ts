import assert from "node:assert/strict";
import test from "node:test";

process.env.MGMT_KEY ??= "test";
process.env.API_CONTAINER_NAME ??= "test";
process.env.RESOURCES_DIR ??= new URL("../resources", import.meta.url).pathname;
const { pa } = await import("../src/api/benchmarks/pa.ts");
const { JobParam } = await import("../src/shared/types.ts");

test("a PA request names exactly one of world or selection", async () => {
	assert.deepEqual(await pa.parse({}), { error: "give exactly one of world or selection" });
	assert.deepEqual(await pa.parse({ world: "email_only_check_inbox", selection: "everyday-v1" }), {
		error: "give exactly one of world or selection",
	});
});

test("a single world yields one job input with its challenge and assistant params", async () => {
	const inputs = await pa.parse({ world: "email_only_check_inbox", assistant: "hermes" });
	assert.ok(Array.isArray(inputs));
	assert.deepEqual(inputs.map((input) => input.params), [{ [JobParam.challenge]: "email_only_check_inbox", [JobParam.assistant]: "hermes" }]);
});

test("an unknown world is named in the error", async () => {
	assert.deepEqual(await pa.parse({ world: "no_such_world" }), { error: "unknown world no_such_world" });
});

test("an unknown selection is named in the error", async () => {
	assert.deepEqual(await pa.parse({ selection: "no_such_selection" }), { error: "unknown selection no_such_selection" });
});

test("a selection name with a path separator is refused", async () => {
	assert.deepEqual(await pa.parse({ selection: "../worlds" }), { error: "unknown selection ../worlds" });
});
