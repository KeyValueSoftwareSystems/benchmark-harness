import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { Benchmark } from "../src/api/benchmarks/types.ts";
import { openDb, upsertRun } from "../src/api/db/runs.ts";
import { insecureKeyGuard } from "../src/api/models/guard.ts";
import { createRegistry } from "../src/api/models/registry.ts";
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

async function serve(opts: { discovery?: boolean } = {}) {
	const db = openDb(":memory:");
	const registry = createRegistry([staticModel]);
	const app = express();
	app.use(express.json());
	app.use(createModelsRouter({ registry, db, benchmarks, discovery: opts.discovery ?? false }));
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

const guardCall = (env: Record<string, string | undefined>, req: { protocol: string; remote: string }) => {
	let status = 0;
	let nextCalled = false;
	const res = { status: (c: number) => ({ json: () => void (status = c) }) };
	insecureKeyGuard(env)({ protocol: req.protocol, socket: { remoteAddress: req.remote } } as never, res as never, () => void (nextCalled = true));
	return { status, nextCalled };
};

test("the key guard refuses plain HTTP from a non-loopback address unless allowed", () => {
	assert.deepEqual(guardCall({}, { protocol: "http", remote: "192.168.1.20" }), { status: 403, nextCalled: false });
	assert.equal(guardCall({}, { protocol: "http", remote: "127.0.0.1" }).nextCalled, true);
	assert.equal(guardCall({}, { protocol: "http", remote: "::1" }).nextCalled, true);
	assert.equal(guardCall({}, { protocol: "https", remote: "192.168.1.20" }).nextCalled, true);
	assert.equal(guardCall({ ALLOW_INSECURE_KEYS: "1" }, { protocol: "http", remote: "192.168.1.20" }).nextCalled, true);
});
