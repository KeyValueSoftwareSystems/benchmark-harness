import assert from "node:assert/strict";
import test from "node:test";
import { canRegister } from "../src/api/models/register.ts";

test("an agent can fetch its model only while its job is starting or running", () => {
	assert.equal(canRegister("provisioning"), true);
	assert.equal(canRegister("running"), true);
	for (const status of ["queued", "done", "error", "cancelled"] as const) assert.equal(canRegister(status), false, status);
});
