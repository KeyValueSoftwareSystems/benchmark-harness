import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { Router } from "express";
import { requireManagementKey } from "../src/api/guard.ts";

const KEY_HEADERS = { "x-mgmt-key": "secret" };

async function serve({ fromJobNetwork = false } = {}) {
	const app = express();
	// Agent routes sit before the guard, the way index.ts mounts them.
	const agent = Router();
	agent.post("/register", (_req, res) => void res.json({ from: "agent" }));
	agent.get("/jobs/:id/context", (_req, res) => void res.json({ from: "agent" }));
	app.use(agent);
	app.use(requireManagementKey({ mgmtKey: "secret", isJobNetwork: () => fromJobNetwork }));
	const management = Router();
	management.get("/jobs", (_req, res) => void res.json({ from: "management" }));
	management.post("/jobs/:id/cancel", (_req, res) => void res.json({ from: "management" }));
	management.get("/register", (_req, res) => void res.json({ from: "management" }));
	app.use(management);
	const server = app.listen(0);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { base, close: () => server.close() };
}

test("a route mounted before the guard needs no key", async () => {
	const { base, close } = await serve();
	try {
		assert.equal((await fetch(`${base}/register`, { method: "POST" })).status, 200);
		assert.equal((await fetch(`${base}/jobs/abc/context`)).status, 200);
	} finally {
		close();
	}
});

test("a route mounted after the guard needs the management key", async () => {
	const { base, close } = await serve();
	try {
		assert.equal((await fetch(`${base}/jobs`)).status, 403);
		assert.equal((await fetch(`${base}/jobs`, { headers: { authorization: "Bearer secret" } })).status, 200);
		assert.equal((await fetch(`${base}/jobs`, { headers: KEY_HEADERS })).status, 200);
		assert.equal((await fetch(`${base}/jobs`, { headers: { "x-mgmt-key": "wrong" } })).status, 403);
	} finally {
		close();
	}
});

test("an agent path with a method the agent router does not handle needs the key", async () => {
	const { base, close } = await serve();
	try {
		assert.equal((await fetch(`${base}/register`)).status, 403);
		assert.equal((await fetch(`${base}/register`, { headers: KEY_HEADERS })).status, 200);
	} finally {
		close();
	}
});

test("job networks may only use the agent routes, even with the key", async () => {
	const { base, close } = await serve({ fromJobNetwork: true });
	try {
		assert.equal((await fetch(`${base}/jobs`, { headers: KEY_HEADERS })).status, 403);
		assert.equal((await fetch(`${base}/jobs/abc/cancel`, { method: "POST", headers: KEY_HEADERS })).status, 403);
		assert.equal((await fetch(`${base}/register`, { headers: KEY_HEADERS })).status, 403);
		assert.equal((await fetch(`${base}/register`, { method: "POST" })).status, 200);
	} finally {
		close();
	}
});
