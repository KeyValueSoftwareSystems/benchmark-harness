import assert from "node:assert/strict";
import test from "node:test";
import { parseQueueLimit } from "../src/api/models/limits.ts";

test("the queue limit defaults to 5", () => {
	assert.equal(parseQueueLimit(undefined), 5);
	assert.equal(parseQueueLimit(""), 5);
});

test("QUEUE_LIMIT sets it to any whole number of 1 or more", () => {
	assert.equal(parseQueueLimit("3"), 3);
	assert.equal(parseQueueLimit("8"), 8);
	assert.equal(parseQueueLimit(" 2 "), 2);
	assert.equal(parseQueueLimit("0"), 5);
	assert.equal(parseQueueLimit("-2"), 5);
});

test("anything that is not a whole number falls back to 5", () => {
	assert.equal(parseQueueLimit("many"), 5);
	assert.equal(parseQueueLimit("2.5"), 5);
});
