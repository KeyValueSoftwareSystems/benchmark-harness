import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { createRunsRouter } from "../src/api/routes/runs.ts";
import type { Job, JobStatus } from "../src/shared/types.ts";

const job = (id: string, status: JobStatus, runId?: string): Job => ({
	id, benchmark: "cyber", prompt: "p", model: "m", status, createdAt: "2026-11-09T00:00:00Z", params: runId ? { runId } : undefined,
});

async function serve(jobs: Job[]) {
	const cancelled: string[] = [];
	const app = express();
	app.use(createRunsRouter({ listJobs: async () => jobs, requestCancel: async (id) => void cancelled.push(id) }));
	const server = app.listen(0);
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return { cancelled, post: (path: string) => fetch(base + path, { method: "POST" }), close: () => server.close() };
}

test("cancelling a run cancels only its unfinished jobs", async () => {
	const s = await serve([job("a", "running", "r1"), job("b", "queued", "r1"), job("c", "done", "r1"), job("d", "running", "r2"), job("e", "provisioning", "r1")]);
	try {
		const res = await s.post("/runs/r1/cancel");
		assert.equal(res.status, 202);
		assert.deepEqual((await res.json()).cancelled.sort(), ["a", "b", "e"]);
		assert.deepEqual(s.cancelled.sort(), ["a", "b", "e"]);
	} finally {
		s.close();
	}
});

test("cancelling a run whose jobs all finished is a no-op, not an error", async () => {
	const s = await serve([job("a", "done", "r1"), job("b", "error", "r1")]);
	try {
		const res = await s.post("/runs/r1/cancel");
		assert.equal(res.status, 202);
		assert.deepEqual((await res.json()).cancelled, []);
		assert.deepEqual(s.cancelled, []);
	} finally {
		s.close();
	}
});

test("an unknown run is a 404", async () => {
	const s = await serve([job("a", "running", "r1")]);
	try {
		assert.equal((await s.post("/runs/nope/cancel")).status, 404);
	} finally {
		s.close();
	}
});

test("GET /runs/:runId returns the run's jobs with whether each one solved its challenge", async () => {
	const app = express();
	app.use(createRunsRouter({ listJobs: async () => [job("a", "done", "r1"), job("b", "done", "r1"), job("c", "done", "r2")], requestCancel: async () => {}, correctByJob: async () => new Map([["a", true], ["b", false]]) }));
	const server = app.listen(0);
	try {
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const res = await fetch(`${base}/runs/r1`);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.deepEqual(body.jobs.map((j: { id: string; correct: boolean | null }) => [j.id, j.correct]), [["a", true], ["b", false]]);
		assert.equal((await fetch(`${base}/runs/nope`)).status, 404);
	} finally {
		server.close();
	}
});
