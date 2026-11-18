import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { SCENARIO_CLOCK_PORT, SCENARIO_CLOCK_SERVICE, SCENARIO_CLOCK_TOOL, withScenarioClock } from "../src/pa/scenario-clock.ts";

const WORLDS = path.resolve("resources/pa/worlds");

const worldWithoutClock = `
task_id: T
execution_date: 2026-04-08
tools:
  - name: gmail_list_messages
    description: List inbox messages
tool_endpoints:
  - tool_name: gmail_list_messages
    url: http://localhost:9100/gmail/messages
    method: POST
services:
  - name: gmail
    port: 9100
`;

const worldWithClockOnOtherPort = `
task_id: T
execution_date: 2026-04-08
services:
  - name: gmail
    port: 9100
  - name: datetime
    port: 9155
`;

function clockCount(world: { services?: { name: string }[]; tools?: { name: string }[]; tool_endpoints?: { tool_name: string }[] }) {
	return {
		services: world.services?.filter((s) => s.name === SCENARIO_CLOCK_SERVICE).length,
		tools: world.tools?.filter((t) => t.name === SCENARIO_CLOCK_TOOL).length,
		endpoints: world.tool_endpoints?.filter((e) => e.tool_name === SCENARIO_CLOCK_TOOL).length,
	};
}

test("appends the clock service last and adds its tool and endpoint", () => {
	const world = YAML.parse(withScenarioClock(worldWithoutClock));

	assert.deepEqual(world.services, [
		{ name: "gmail", port: 9100 },
		{ name: SCENARIO_CLOCK_SERVICE, port: SCENARIO_CLOCK_PORT },
	]);
	assert.equal(world.tools[0].name, "gmail_list_messages");
	assert.equal(world.tools[1].name, SCENARIO_CLOCK_TOOL);
	assert.deepEqual(world.tools[1].input_schema, { type: "object", properties: {} });
	assert.deepEqual(world.tool_endpoints, [
		{ tool_name: "gmail_list_messages", url: "http://localhost:9100/gmail/messages", method: "POST" },
		{ tool_name: SCENARIO_CLOCK_TOOL, url: `http://localhost:${SCENARIO_CLOCK_PORT}/datetime`, method: "POST" },
	]);
	assert.equal(world.execution_date, "2026-04-08");
});

test("is idempotent", () => {
	const once = withScenarioClock(worldWithoutClock);
	const twice = withScenarioClock(once);

	assert.deepEqual(YAML.parse(twice), YAML.parse(once));
});

test("keeps an existing clock service on its own port and points the endpoint there", () => {
	const world = YAML.parse(withScenarioClock(worldWithClockOnOtherPort));

	assert.deepEqual(world.services, [
		{ name: "gmail", port: 9100 },
		{ name: SCENARIO_CLOCK_SERVICE, port: 9155 },
	]);
	assert.deepEqual(clockCount(world), { services: 1, tools: 1, endpoints: 1 });
	assert.equal(world.tool_endpoints.find((e: { tool_name: string }) => e.tool_name === SCENARIO_CLOCK_TOOL).url, "http://localhost:9155/datetime");
});

test("throws when another service already uses the clock port", () => {
	const clashing = `
services:
  - name: gmail
    port: ${SCENARIO_CLOCK_PORT}
`;

	assert.throws(() => withScenarioClock(clashing), new RegExp(`gmail.*${SCENARIO_CLOCK_PORT}`));
});

for (const id of readdirSync(WORLDS).sort()) {
	test(`world ${id} gets exactly one scenario clock`, () => {
		const raw = readFileSync(path.join(WORLDS, id, "world.yaml"), "utf8");
		assert.equal(typeof YAML.parse(raw).execution_date, "string");

		const world = YAML.parse(withScenarioClock(raw));
		assert.deepEqual(clockCount(world), { services: 1, tools: 1, endpoints: 1 });
	});
}
