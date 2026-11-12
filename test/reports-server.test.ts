import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { createReportsRouter } from "../src/api/routes/reports.ts";
import { createReportsApp } from "../src/reports/app.ts";

async function serveApp(generate: (args: { benchmark: string; models: string[] }) => Promise<{ id: string }>) {
	const reportsDir = mkdtempSync(join(tmpdir(), "rep-"));
	writeFileSync(join(reportsDir, "cyber-1.html"), "<h1>report</h1>");
	const app = createReportsApp({ generate: generate as never, reportsDir, resultsDir: "/unused" });
	const server = app.listen(0);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, close: () => server.close() };
}
const post = (base: string, body: unknown) => fetch(`${base}/reports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("POST /reports returns the id of the generated report", async () => {
	let seen: unknown;
	const s = await serveApp(async (args) => ((seen = args), { id: "cyber-1" }));
	try {
		const res = await post(s.base, { benchmark: "cyber", models: ["a", "b"] });
		assert.equal(res.status, 201);
		assert.deepEqual(await res.json(), { id: "cyber-1" });
		assert.equal((seen as { benchmark: string }).benchmark, "cyber");
		assert.deepEqual((seen as { models: string[] }).models, ["a", "b"]);
	} finally {
		s.close();
	}
});

test("POST /reports rejects an empty or malformed request", async () => {
	const s = await serveApp(async () => ({ id: "x" }));
	try {
		assert.equal((await post(s.base, { benchmark: "cyber", models: [] })).status, 400);
		assert.equal((await post(s.base, { models: ["a"] })).status, 400);
		assert.equal((await post(s.base, { benchmark: "cyber", models: [1] })).status, 400);
	} finally {
		s.close();
	}
});

test("a generate failure is a 400 with its message", async () => {
	const s = await serveApp(async () => {
		throw new Error('no results for model "a" on benchmark "cyber"');
	});
	try {
		const res = await post(s.base, { benchmark: "cyber", models: ["a"] });
		assert.equal(res.status, 400);
		assert.match((await res.json()).error, /no results for model/);
	} finally {
		s.close();
	}
});

test("GET /reports/:id serves the HTML, 404 for a missing one, 400 for a path-like id", async () => {
	const s = await serveApp(async () => ({ id: "x" }));
	try {
		const ok = await fetch(`${s.base}/reports/cyber-1`);
		assert.equal(ok.status, 200);
		assert.match(ok.headers.get("content-type") ?? "", /text\/html/);
		assert.equal(await ok.text(), "<h1>report</h1>");
		assert.equal((await fetch(`${s.base}/reports/missing`)).status, 404);
		assert.equal((await fetch(`${s.base}/reports/..%2Fsecret`)).status, 400);
	} finally {
		s.close();
	}
});

async function serveProxy(fetchImpl: typeof fetch) {
	const app = express();
	app.use(express.json());
	app.use(createReportsRouter({ baseUrl: "http://reports-api:3001", fetchImpl }));
	const server = app.listen(0);
	return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("the proxy forwards POST /reports and returns the upstream status and body", async () => {
	let upstream: { url: string; body: string } | undefined;
	const s = await serveProxy((async (url: string, init: RequestInit) => ((upstream = { url, body: String(init.body) }), new Response(JSON.stringify({ id: "r1" }), { status: 201, headers: { "content-type": "application/json" } }))) as never);
	try {
		const res = await post(s.base, { benchmark: "cyber", models: ["a"] });
		assert.equal(res.status, 201);
		assert.deepEqual(await res.json(), { id: "r1" });
		assert.equal(upstream?.url, "http://reports-api:3001/reports");
		assert.deepEqual(JSON.parse(upstream?.body ?? ""), { benchmark: "cyber", models: ["a"] });
	} finally {
		s.close();
	}
});

test("the proxy serves a report's HTML from upstream", async () => {
	const s = await serveProxy((async () => new Response("<h1>hi</h1>", { status: 200, headers: { "content-type": "text/html" } })) as never);
	try {
		const res = await fetch(`${s.base}/reports/cyber-1`);
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "<h1>hi</h1>");
	} finally {
		s.close();
	}
});

test("an unreachable report service is a 502 that hides the cause", async () => {
	const s = await serveProxy((async () => {
		throw new Error("connect ECONNREFUSED 10.0.0.9:3001");
	}) as never);
	try {
		const res = await post(s.base, { benchmark: "cyber", models: ["a"] });
		assert.equal(res.status, 502);
		const text = await res.text();
		assert.match(text, /report service unavailable/);
		assert.ok(!text.includes("10.0.0.9"));
	} finally {
		s.close();
	}
});
