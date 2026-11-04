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

// ---- the extension itself, driven by a fake pi
type Handler = (event?: unknown) => unknown;
function fakePi() {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Handler[]>();
	const add = (map: Map<string, Handler[]>, name: string, h: Handler) => void map.set(name, [...(map.get(name) ?? []), h]);
	return {
		on: (name: string, h: Handler) => add(handlers, name, h),
		events: { on: (name: string, h: Handler) => add(bus, name, h), emit: (name: string, data: unknown) => (bus.get(name) ?? []).forEach((h) => h(data)) },
		fire: async (name: string, event?: unknown) => {
			for (const h of handlers.get(name) ?? []) await h(event);
		},
	};
}

async function withEnvAndFetch<T>(tokenReplies: Response[], run: (posts: { headers: Headers; body: any }[]) => Promise<T>) {
	const saved = { fetch: globalThis.fetch, api: process.env.API_URL, job: process.env.JOB_ID };
	process.env.API_URL = "http://api";
	process.env.JOB_ID = "j1";
	const posts: { headers: Headers; body: any }[] = [];
	const replies = [...tokenReplies];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		if (init?.method === "POST") {
			posts.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
			return new Response(null, { status: 202 });
		}
		return replies.shift() ?? new Response(null, { status: 403 });
	}) as typeof fetch;
	try {
		return await run(posts);
	} finally {
		globalThis.fetch = saved.fetch;
		process.env.API_URL = saved.api;
		process.env.JOB_ID = saved.job;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = { message: { role: "assistant", usage: { input: 5, output: 2, cost: { total: 0.1 } } } };

test("an outcome emitted after agent_end (after an async step) still reaches the api", async () => {
	const { default: extension } = await import("../src/extensions/results/index.ts");
	await withEnvAndFetch([Response.json({ token: "tok" })], async (posts) => {
		const pi = fakePi();
		extension(pi as never);
		await pi.fire("session_start");
		await pi.fire("agent_start");
		await pi.fire("turn_start");
		await pi.fire("message_end", msg);
		await pi.fire("agent_end");
		await sleep(30);
		pi.events.emit("benchmark_result", { correct: true, flag: "f" });
		assert.equal(posts.length, 0); // nothing is sent until the session shuts down
		await pi.fire("session_shutdown");
		assert.equal(posts.length, 1);
		assert.deepEqual(posts[0].body.outcome, { correct: true, flag: "f" });
		assert.equal(posts[0].body.metrics.turns, 1);
		assert.equal(posts[0].headers.get("x-result-token"), "tok");
	});
});

test("a second session_start does not lose the token the first one fetched", async () => {
	const { default: extension } = await import("../src/extensions/results/index.ts");
	await withEnvAndFetch([Response.json({ token: "tok" })], async (posts) => {
		const pi = fakePi();
		extension(pi as never);
		await pi.fire("session_start");
		await pi.fire("session_start"); // the api would now answer 403
		await pi.fire("agent_end");
		await pi.fire("session_shutdown");
		assert.equal(posts[0].headers.get("x-result-token"), "tok");
	});
});

test("the result is reported once even if shutdown fires twice", async () => {
	const { default: extension } = await import("../src/extensions/results/index.ts");
	await withEnvAndFetch([Response.json({ token: "tok" })], async (posts) => {
		const pi = fakePi();
		extension(pi as never);
		await pi.fire("session_start");
		await pi.fire("session_shutdown");
		await pi.fire("session_shutdown");
		assert.equal(posts.length, 1);
	});
});

test("a run that never reached agent_end still reports its usage at shutdown", async () => {
	const { default: extension } = await import("../src/extensions/results/index.ts");
	await withEnvAndFetch([Response.json({ token: "tok" })], async (posts) => {
		const pi = fakePi();
		extension(pi as never);
		await pi.fire("session_start");
		await pi.fire("turn_start");
		await pi.fire("message_end", msg);
		await pi.fire("session_shutdown");
		assert.equal(posts[0].body.outcome, null);
		assert.equal(posts[0].body.metrics.inputTokens, 5);
	});
});
