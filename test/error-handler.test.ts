import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { jsonErrorHandler } from "../src/api/errors.ts";

test("malformed JSON is a 400 that never echoes or logs the body, which can hold an API key", async () => {
	const logged: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => void logged.push(args.join(" "));
	const app = express();
	app.use(express.json());
	app.post("/x", (_req, res) => void res.json({ ok: true }));
	app.use(jsonErrorHandler);
	const server = app.listen(0);
	try {
		const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/x`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"apiKey":"sk-leak-me", oops' });
		const text = await res.text();
		assert.equal(res.status, 400);
		assert.deepEqual(JSON.parse(text), { error: "invalid JSON" });
		assert.ok(!text.includes("sk-leak-me"));
		assert.ok(!logged.join("\n").includes("sk-leak-me"));
	} finally {
		console.error = original;
		server.close();
	}
});

test("other errors are a 500 with no details", async () => {
	const app = express();
	app.get("/boom", () => {
		throw new Error("secret detail sk-abc");
	});
	app.use(jsonErrorHandler);
	const server = app.listen(0);
	try {
		const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/boom`);
		const text = await res.text();
		assert.equal(res.status, 500);
		assert.ok(!text.includes("sk-abc"));
	} finally {
		server.close();
	}
});
