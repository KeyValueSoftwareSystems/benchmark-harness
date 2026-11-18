import assert from "node:assert/strict";
import test from "node:test";
import { nextTheme, resolveTheme } from "../src/ui/theme.js";

test("a saved theme wins over the system setting", () => {
	assert.equal(resolveTheme("dark", false), "dark");
	assert.equal(resolveTheme("light", true), "light");
});

test("a missing or invalid saved value follows the system setting", () => {
	assert.equal(resolveTheme(null, true), "dark");
	assert.equal(resolveTheme(null, false), "light");
	assert.equal(resolveTheme("purple", true), "dark");
	assert.equal(resolveTheme("", false), "light");
});

test("nextTheme flips between light and dark", () => {
	assert.equal(nextTheme("light"), "dark");
	assert.equal(nextTheme("dark"), "light");
});
