import assert from "node:assert/strict";
import test from "node:test";
import type { Redis } from "ioredis";
import { resetContextClaim } from "../src/api/queue/store.ts";

test("re-running a job clears the previous attempt's context claim, result and token", async () => {
	const deleted: unknown[][] = [];
	const redis = { hdel: async (...args: unknown[]) => void deleted.push(args) } as unknown as Redis;
	await resetContextClaim(redis, "j1");
	assert.deepEqual(deleted, [["job:j1", "contextServed", "result", "resultToken"]]);
});
