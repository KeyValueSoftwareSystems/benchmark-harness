import assert from "node:assert/strict";
import test from "node:test";
import { buildPayload, postResult } from "../src/extensions/results/payload.ts";

const state = {
	usages: [
		{ input: 10, output: 5, cost: 0.01 },
		{ input: 20, output: 7, cost: 0.02 },
	],
	turns: 2,
	startedAt: 1_000,
	endedAt: 4_500,
	outcome: { correct: true, flag: "f" } as Record<string, unknown> | null,
	sessionId: "sess-1" as string | undefined,
};

test("buildPayload sums usage, counts turns and measures duration", () => {
	const p = buildPayload(state);
	assert.deepEqual(p.metrics, { turns: 2, durationMs: 3500, inputTokens: 30, outputTokens: 12, costUsd: 0.03 });
	assert.deepEqual(p.outcome, { correct: true, flag: "f" });
	assert.equal(p.sessionId, "sess-1");
});

test("buildPayload keeps outcome null when the benchmark emitted no result", () => {
	assert.equal(buildPayload({ ...state, outcome: null, sessionId: undefined }).outcome, null);
	assert.equal("sessionId" in buildPayload({ ...state, sessionId: undefined }), false);
});

test("postResult retries failures and stops after a success", async () => {
	let calls = 0;
	const fetchFn = async () => new Response(null, { status: ++calls < 3 ? 500 : 202 });
	const ok = await postResult("http://api/jobs/j/result", buildPayload(state), { fetchFn, sleep: async () => {}, attempts: 5 });
	assert.equal(ok, true);
	assert.equal(calls, 3);
});

test("postResult gives up after the attempt budget without throwing", async () => {
	let calls = 0;
	const fetchFn = async () => {
		calls++;
		throw new Error("down");
	};
	const ok = await postResult("http://api/x", buildPayload(state), { fetchFn, sleep: async () => {}, attempts: 3 });
	assert.equal(ok, false);
	assert.equal(calls, 3);
});

test("postResult treats 409 (already reported) as done", async () => {
	const ok = await postResult("http://api/x", buildPayload(state), {
		fetchFn: async () => new Response(null, { status: 409 }),
		sleep: async () => {},
		attempts: 3,
	});
	assert.equal(ok, true);
});
