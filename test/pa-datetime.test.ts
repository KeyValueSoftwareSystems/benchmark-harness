import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import { DEFAULT_EXECUTION_TIME, scenarioNow } from "../src/pa/mock-services/datetime.ts";

const TODAY = "2030-01-01";

test("the clock reports the world's date, time and UTC offset", () => {
	const now = scenarioNow({ execution_date: "2026-04-02", execution_time: "16:45:00", utc_offset: "+01:00" }, TODAY);
	assert.deepEqual(now, { current_date: "2026-04-02", current_time: "16:45:00", timezone: "UTC+01:00" });
});

test("a world without a time or offset gets the default morning time at UTC", () => {
	const now = scenarioNow({ execution_date: "2026-04-02" }, TODAY);
	assert.deepEqual(now, { current_date: "2026-04-02", current_time: DEFAULT_EXECUTION_TIME, timezone: "UTC+00:00" });
});

test("a world with no date falls back to today's date", () => {
	assert.equal(scenarioNow({}, TODAY).current_date, TODAY);
});

test("every world sets a time of day and a UTC offset", () => {
	const worlds = path.resolve("resources/pa/worlds");
	for (const id of readdirSync(worlds)) {
		const world = YAML.parse(readFileSync(path.join(worlds, id, "world.yaml"), "utf8"));
		assert.match(String(world.execution_time), /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/, `${id}: execution_time`);
		assert.match(String(world.utc_offset), /^[+-]\d{2}:\d{2}$/, `${id}: utc_offset`);
	}
});
