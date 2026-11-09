import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { Benchmark } from "../src/api/benchmarks/types.ts";
import { openDb, upsertRun } from "../src/api/db/runs.ts";
import { insecureKeyGuard } from "../src/api/models/guard.ts";
import { createRegistry } from "../src/api/models/registry.ts";
import { DiscoveryError } from "../src/api/discovery/fetch.ts";
import { createModelsRouter } from "../src/api/routes/models.ts";
import type { RunRecord } from "../src/shared/results.ts";
import type { ModelConfig } from "../src/shared/types.ts";

const KEY = "sk-secret-123";
const staticModel: ModelConfig = { name: "static-a", baseUrl: "https://s/v1", apiKey: "static-secret", api: "openai-completions", modelId: "a-1" };
const benchmarks = new Map<string, Benchmark>([
	["cyber", { name: "cyber", concurrency: 1, challenges: async () => ["locktalk", "chunky"], parse: async () => [], run: async () => ({ status: "done" }) }],
	["minimal", { name: "minimal", concurrency: 1, parse: async () => [], run: async () => ({ status: "done" }) }],
]);
const run = (model: string, benchmark: string): RunRecord => ({
	jobId: `${model}-${benchmark}`, benchmark, model, modelId: model, challenge: null, status: "done", correct: true, outcome: null,
	metrics: { turns: 1, durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 }, sessionId: null, traceIds: null, netraMetadata: null,
	conditions: {}, createdAt: "2026-11-09T00:00:00Z", finishedAt: "2026-11-09T00:00:01Z",
});

async function serve(opts: { discovery?: boolean; discover?: (url: string) => Promise<unknown>; busy?: string[] } = {}) {
	const db = openDb(":memory:");
	const registry = createRegistry([staticModel]);
	const app = express();
	app.use(express.json());
	app.use(createModelsRouter({ registry, db, benchmarks, discovery: opts.discovery ?? false, discover: opts.discover as never, queueLimit: 4, isBusy: async (name: string) => (opts.busy ?? []).includes(name) }));
	const server = app.listen(0);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await res.text();
		return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
	};
	return { db, registry, call, close: () => server.close() };
}

const body = (over: Record<string, unknown> = {}) => ({ name: "new-m", baseUrl: "https://n/v1", api: "openai-completions", apiKey: KEY, ...over });

test("no response ever contains a submitted or configured key", async () => {
	const s = await serve();
	try {
		const created = await s.call("POST", "/models", body());
		assert.equal(created.status, 201);
		const list = await s.call("GET", "/models");
		for (const text of [created.text, list.text]) {
			assert.ok(!text.includes(KEY), "session key leaked");
			assert.ok(!text.includes("static-secret"), "static key leaked");
		}
	} finally {
		s.close();
	}
});

test("POST /models defaults modelId to the name and rejects missing fields", async () => {
	const s = await serve();
	try {
		const ok = await s.call("POST", "/models", body());
		assert.equal(ok.json.modelId, "new-m");
		const bad = await s.call("POST", "/models", { name: "x" });
		assert.equal(bad.status, 400);
	} finally {
		s.close();
	}
});

test("a name that clashes with a configured model is refused with 409", async () => {
	const s = await serve();
	try {
		const res = await s.call("POST", "/models", body({ name: "static-a" }));
		assert.equal(res.status, 409);
		assert.equal(s.registry.find("static-a")?.apiKey, "static-secret");
	} finally {
		s.close();
	}
});

test("a name containing HTML round-trips as plain data", async () => {
	const s = await serve();
	try {
		const name = "<img src=x onerror=alert(1)>";
		await s.call("POST", "/models", body({ name }));
		const list = await s.call("GET", "/models");
		assert.ok(list.json.models.some((m: { name: string }) => m.name === name));
	} finally {
		s.close();
	}
});

test("PUT /models/:name/key supplies a missing key, DELETE removes, static models are untouchable", async () => {
	const s = await serve();
	try {
		await s.call("POST", "/models", body({ apiKey: "" }));
		const before = await s.call("GET", "/models");
		assert.equal(before.json.models.find((m: { name: string }) => m.name === "new-m").needsKey, true);
		assert.equal((await s.call("PUT", "/models/new-m/key", { apiKey: KEY })).status, 204);
		const after = await s.call("GET", "/models");
		assert.equal(after.json.models.find((m: { name: string }) => m.name === "new-m").needsKey, false);
		assert.equal((await s.call("DELETE", "/models/new-m")).status, 204);
		assert.equal((await s.call("DELETE", "/models/static-a")).status, 404);
		assert.equal((await s.call("PUT", "/models/static-a/key", { apiKey: "x" })).status, 404);
	} finally {
		s.close();
	}
});

test("GET /models lists benchmarked benchmarks and read-only models that only have stored results", async () => {
	const s = await serve({ discovery: true });
	try {
		upsertRun(s.db, run("static-a", "cyber"));
		upsertRun(s.db, run("static-a", "minimal"));
		upsertRun(s.db, run("gone-model", "cyber"));
		const list = await s.call("GET", "/models");
		assert.equal(list.json.discovery, true);
		const a = list.json.models.find((m: { name: string }) => m.name === "static-a");
		assert.deepEqual(a.benchmarked.sort(), ["cyber", "minimal"]);
		assert.equal(a.session, false);
		const gone = list.json.models.find((m: { name: string }) => m.name === "gone-model");
		assert.equal(gone.readOnly, true);
		assert.equal(gone.needsKey, true);
	} finally {
		s.close();
	}
});

test("GET /benchmarks lists challenges and which benchmark needs a prompt", async () => {
	const s = await serve();
	try {
		const res = await s.call("GET", "/benchmarks");
		assert.deepEqual(res.json, [
			{ name: "cyber", challenges: ["locktalk", "chunky"], needsPrompt: false },
			{ name: "minimal", challenges: [], needsPrompt: true },
		]);
	} finally {
		s.close();
	}
});

const guardCall = (env: Record<string, string | undefined>, req: { protocol: string; remote: string; host?: string }) => {
	let status = 0;
	let nextCalled = false;
	const res = { status: (c: number) => ({ json: () => void (status = c) }) };
	const fake = { protocol: req.protocol, hostname: req.host ?? "api.internal", socket: { remoteAddress: req.remote } };
	insecureKeyGuard(env)(fake as never, res as never, () => void (nextCalled = true));
	return { status, nextCalled };
};

test("the key guard refuses plain HTTP from a non-loopback address unless allowed", () => {
	assert.deepEqual(guardCall({}, { protocol: "http", remote: "192.168.1.20" }), { status: 403, nextCalled: false });
	assert.equal(guardCall({}, { protocol: "http", remote: "127.0.0.1" }).nextCalled, true);
	assert.equal(guardCall({}, { protocol: "http", remote: "::1" }).nextCalled, true);
	assert.equal(guardCall({}, { protocol: "https", remote: "192.168.1.20" }).nextCalled, true);
	assert.equal(guardCall({ ALLOW_INSECURE_KEYS: "1" }, { protocol: "http", remote: "192.168.1.20" }).nextCalled, true);
});

test("a browser using a localhost address counts as local even though Docker shows a bridge address", () => {
	assert.equal(guardCall({}, { protocol: "http", remote: "172.18.0.1", host: "localhost" }).nextCalled, true);
	assert.equal(guardCall({}, { protocol: "http", remote: "172.18.0.1", host: "127.0.0.1" }).nextCalled, true);
	assert.equal(guardCall({}, { protocol: "http", remote: "172.18.0.1", host: "192.168.1.5" }).nextCalled, false);
	assert.equal(guardCall({}, { protocol: "http", remote: "172.18.0.1", host: "localhost.evil.test" }).nextCalled, false);
});

test("POST /models/discover returns the discovered parameters", async () => {
	const s = await serve({ discovery: true, discover: async (url) => ({ thinkingLevels: ["off"], seen: url }) });
	try {
		const res = await s.call("POST", "/models/discover", { docsUrl: "https://docs.example/m" });
		assert.equal(res.status, 200);
		assert.deepEqual(res.json, { thinkingLevels: ["off"], seen: "https://docs.example/m" });
	} finally {
		s.close();
	}
});

test("POST /models/discover is 404 when no discovery model is configured", async () => {
	const s = await serve();
	try {
		assert.equal((await s.call("POST", "/models/discover", { docsUrl: "https://docs.example/m" })).status, 404);
	} finally {
		s.close();
	}
});

test("POST /models/discover shows a refused link as a 400 with the reason, and hides other failures", async () => {
	const refused = await serve({ discovery: true, discover: async () => { throw new DiscoveryError("only https links are allowed"); } });
	const broken = await serve({ discovery: true, discover: async () => { throw new Error("secret internal detail"); } });
	try {
		const a = await refused.call("POST", "/models/discover", { docsUrl: "http://x" });
		assert.equal(a.status, 400);
		assert.equal(a.json.error, "only https links are allowed");
		const b = await broken.call("POST", "/models/discover", { docsUrl: "https://x" });
		assert.equal(b.status, 502);
		assert.ok(!b.text.includes("secret internal detail"));
		assert.equal((await refused.call("POST", "/models/discover", {})).status, 400);
	} finally {
		refused.close();
		broken.close();
	}
});

test("GET /models tells the page how many items its queue may hold", async () => {
	const s = await serve();
	try {
		assert.equal((await s.call("GET", "/models")).json.queueLimit, 4);
	} finally {
		s.close();
	}
});

test("a model with a job still queued or running cannot be removed, so its job is not stranded", async () => {
	const s = await serve({ busy: ["new-m"] });
	try {
		await s.call("POST", "/models", body());
		const res = await s.call("DELETE", "/models/new-m");
		assert.equal(res.status, 409);
		assert.match(res.json.error, /still has a job/i);
		assert.ok(s.registry.find("new-m"), "the model must still be there");
	} finally {
		s.close();
	}
});
