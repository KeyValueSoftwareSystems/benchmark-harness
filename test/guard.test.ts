import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { Router } from "express";
import { createGuard } from "../src/api/guard.ts";

async function serve({ fromJobNetwork = false } = {}) {
	const app = express();
	app.use(createGuard({ mgmtKey: "secret", isJobNetwork: () => fromJobNetwork }));
	// Mounted before the jobs routes, the way an agent router is; it must not open them up.
	const early = Router();
	early.get("/jobs", (_req, res) => void res.json({ from: "early" }));
	app.use(early);
	const jobs = Router();
	jobs.get("/jobs", (_req, res) => void res.json({ from: "jobs" }));
	app.use(jobs);
	app.use((_req, res) => void res.status(200).json({ reached: true }));
	const server = app.listen(0);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, close: () => server.close() };
}

test("a router mounted before jobs does not bypass the management key", async () => {
	const { base, close } = await serve();
	try {
		assert.equal((await fetch(`${base}/jobs`)).status, 403);
		assert.equal((await fetch(`${base}/jobs`, { headers: { authorization: "Bearer secret" } })).status, 200);
		assert.equal((await fetch(`${base}/jobs`, { headers: { "x-mgmt-key": "secret" } })).status, 200);
		assert.equal((await fetch(`${base}/jobs`, { headers: { "x-mgmt-key": "wrong" } })).status, 403);
	} finally {
		close();
	}
});

test("agent routes need no management key", async () => {
	const { base, close } = await serve();
	try {
		for (const [method, path] of [
			["POST", "/register"],
			["GET", "/jobs/abc/context"],
			["POST", "/jobs/abc/exchanges"],
			["GET", "/jobs/abc/result-token"],
			["POST", "/jobs/abc/result"],
			["POST", "/llm/v1/chat/completions"],
		]) {
			assert.equal((await fetch(`${base}${path}`, { method })).status, 200, `${method} ${path}`);
		}
	} finally {
		close();
	}
});

test("job networks may only use agent routes, even with the key", async () => {
	const { base, close } = await serve({ fromJobNetwork: true });
	try {
		assert.equal((await fetch(`${base}/jobs`, { headers: { "x-mgmt-key": "secret" } })).status, 403);
		assert.equal((await fetch(`${base}/jobs/abc/cancel`, { method: "POST" })).status, 403);
		assert.equal((await fetch(`${base}/register`, { method: "POST" })).status, 200);
	} finally {
		close();
	}
});
