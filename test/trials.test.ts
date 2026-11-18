import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TRIALS, parseTrials, trialOf, withTrial } from "../src/api/trials.ts";

test("parseTrials defaults to one trial when the field is absent", () => {
	assert.equal(parseTrials(undefined), 1);
});

test("parseTrials accepts integers from 1 to MAX_TRIALS", () => {
	assert.equal(parseTrials(1), 1);
	assert.equal(parseTrials(MAX_TRIALS), MAX_TRIALS);
});

test("parseTrials rejects zero, too many, fractions, strings and null", () => {
	for (const bad of [0, MAX_TRIALS + 1, 1.5, "3", null, -2, Number.NaN]) {
		assert.ok(typeof parseTrials(bad) === "object", `expected an error for ${String(bad)}`);
	}
});

test("parseTrials error names the allowed range", () => {
	assert.deepEqual(parseTrials(0), { error: `trials must be an integer from 1 to ${MAX_TRIALS}` });
});

test("withTrial sets the trial as a decimal string and keeps the other params", () => {
	assert.deepEqual(withTrial({ challenge: "c1", assistant: "hermes" }, 3), { challenge: "c1", assistant: "hermes", trial: "3" });
});

test("withTrial works without params", () => {
	assert.deepEqual(withTrial(undefined, 1), { trial: "1" });
});

test("trialOf reads the trial and treats missing or invalid values as the first trial", () => {
	assert.equal(trialOf({ trial: "4" }), 4);
	assert.equal(trialOf({ challenge: "c1" }), 1);
	assert.equal(trialOf(undefined), 1);
	assert.equal(trialOf({ trial: "abc" }), 1);
	assert.equal(trialOf({ trial: "0" }), 1);
	assert.equal(trialOf({ trial: "2.5" }), 1);
});
