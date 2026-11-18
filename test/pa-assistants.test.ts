import assert from "node:assert/strict";
import test from "node:test";
import { isPaAssistant, PAA_PROFILES, PaAssistant } from "../src/pa/constants.ts";

test("hermes and openclaw are assistants; anything else is not", () => {
	assert.equal(isPaAssistant("hermes"), true);
	assert.equal(isPaAssistant("openclaw"), true);
	assert.equal(isPaAssistant("toString"), false);
	assert.equal(isPaAssistant(undefined), false);
});

test("every assistant has a profile with its own image and scratch directory", () => {
	const profiles = Object.values(PaAssistant).map((name) => PAA_PROFILES[name]);
	assert.equal(new Set(profiles.map((p) => p.image)).size, profiles.length);
	for (const profile of profiles) assert.ok(profile.scratchDir.startsWith("/") && profile.uid > 0);
});
