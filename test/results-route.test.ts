import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createResultsRouter } from "../src/api/routes/results.ts";

const metrics = { turns: 1, durationMs: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 };

async function serve() {
	const saved = new Map<string, unknown>();
	const app = express();
	app.use(express.json());
	app.use(
		createResultsRouter({
			jobExists: async (id) => id !== "ghost",
			saveResult: async (id, payload) => {
				if (saved.has(id)) return false;
				saved.set(id, payload);
				return true;
			},
		}),
	);
	const server = app.listen(0);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = (id: string, body: unknown) =>
		fetch(`${base}/jobs/${id}/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { post, saved, close: () => server.close() };
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
