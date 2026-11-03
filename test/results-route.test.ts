import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createResultsRouter } from "../src/api/routes/results.ts";

const metrics = { turns: 1, durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 };

async function serve() {
	const saved = new Map<string, unknown>();
	const issued = new Set<string>();
	const app = express();
	app.use(express.json());
	app.use(
		createResultsRouter({
			jobExists: async (id) => id !== "ghost",
			issueToken: async (id) => {
				if (issued.has(id)) return undefined;
				issued.add(id);
				return `tok-${id}`;
			},
			verifyToken: async (id, token) => token === `tok-${id}`,
			saveResult: async (id, payload) => {
				if (saved.has(id)) return false;
				saved.set(id, payload);
				return true;
			},
		}),
	);
	const server = app.listen(0);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = (id: string, body: unknown, token: string | undefined = `tok-${id}`) =>
		fetch(`${base}/jobs/${id}/result`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(token ? { "x-result-token": token } : {}) },
			body: JSON.stringify(body),
		});
	const getToken = (id: string) => fetch(`${base}/jobs/${id}/result-token`);
	return { post, getToken, saved, close: () => server.close() };
}

test("first result is accepted (202), a repeat is a 409", async () => {
	const s = await serve();
	assert.equal((await s.post("j1", { outcome: { correct: true }, metrics })).status, 202);
	assert.equal((await s.post("j1", { outcome: null, metrics })).status, 409);
	assert.deepEqual(s.saved.get("j1"), { outcome: { correct: true }, metrics });
	s.close();
});

test("unknown job is 404 and a payload without metrics is 400", async () => {
	const s = await serve();
	assert.equal((await s.post("ghost", { outcome: null, metrics })).status, 404);
	assert.equal((await s.post("j2", { outcome: null })).status, 400);
	assert.equal((await s.post("j2", { outcome: "nope", metrics })).status, 400);
	assert.equal((await s.post("j2", { outcome: null, metrics: { ...metrics, turns: "x" } })).status, 400);
	assert.equal(s.saved.size, 0);
	s.close();
});

test("a result without the job's token, or with another job's token, is refused and not stored", async () => {
	const s = await serve();
	const body = { outcome: { correct: true }, metrics };
	assert.equal((await s.post("j1", body, "")).status, 403);
	assert.equal((await s.post("j1", body, "tok-j2")).status, 403);
	assert.equal(s.saved.size, 0);
	s.close();
});

test("a forged result cannot pre-empt the honest one: the honest token still wins", async () => {
	const s = await serve();
	await s.post("j1", { outcome: { correct: true }, metrics }, "guess");
	assert.equal((await s.post("j1", { outcome: { correct: false }, metrics })).status, 202);
	assert.deepEqual(s.saved.get("j1"), { outcome: { correct: false }, metrics });
	s.close();
});

test("the token is served once per job", async () => {
	const s = await serve();
	const first = await s.getToken("j1");
	assert.equal(first.status, 200);
	assert.deepEqual(await first.json(), { token: "tok-j1" });
	assert.equal((await s.getToken("j1")).status, 403);
	assert.equal((await s.getToken("ghost")).status, 404);
	s.close();
});
