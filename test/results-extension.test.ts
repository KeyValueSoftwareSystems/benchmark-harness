import assert from "node:assert/strict";
import test from "node:test";
import { buildPayload, fetchResultToken, postResult } from "../src/extensions/results/payload.ts";

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

test("postResult sends the job's token in x-result-token", async () => {
	let header: string | null = null;
	const fetchFn = async (_url: unknown, init?: RequestInit) => {
		header = new Headers(init?.headers).get("x-result-token");
		return new Response(null, { status: 202 });
	};
	await postResult("http://api/x", buildPayload(state), { fetchFn, sleep: async () => {}, token: "tok-1" });
	assert.equal(header, "tok-1");
});

test("fetchResultToken returns the token, retries failures, and does not retry a refusal", async () => {
	let calls = 0;
	const flaky = async () => (++calls < 3 ? new Response(null, { status: 500 }) : Response.json({ token: "t" }));
	assert.equal(await fetchResultToken("http://api/t", { fetchFn: flaky, sleep: async () => {}, attempts: 5 }), "t");
	assert.equal(calls, 3);

	let refused = 0;
	const no = async () => (refused++, new Response(null, { status: 403 }));
	assert.equal(await fetchResultToken("http://api/t", { fetchFn: no, sleep: async () => {}, attempts: 5 }), undefined);
	assert.equal(refused, 1);
});
