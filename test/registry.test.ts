import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry, keyError } from "../src/api/models/registry.ts";
import type { ModelConfig } from "../src/shared/types.ts";

const model = (name: string, apiKey = "k"): ModelConfig => ({ name, baseUrl: "https://x/v1", apiKey, api: "openai-completions", modelId: name });

test("find returns static and session models", () => {
	const r = createRegistry([model("static-a")]);
	assert.equal(r.add(model("session-b")), "ok");
	assert.equal(r.find("static-a")?.name, "static-a");
	assert.equal(r.find("session-b")?.name, "session-b");
	assert.equal(r.find("nope"), undefined);
});

test("adding a name that clashes with a static model is refused and leaves it untouched", () => {
	const r = createRegistry([model("static-a", "real-key")]);
	assert.equal(r.add(model("static-a", "other")), "clash");
	assert.equal(r.find("static-a")?.apiKey, "real-key");
});

test("a clash with an existing session model is refused too", () => {
	const r = createRegistry([]);
	r.add(model("s"));
	assert.equal(r.add(model("s")), "clash");
});

test("remove and setKey only touch session models", () => {
	const r = createRegistry([model("static-a")]);
	r.add(model("s"));
	assert.equal(r.remove("static-a"), false);
	assert.equal(r.setKey("static-a", "x"), false);
	assert.equal(r.setKey("s", "new"), true);
	assert.equal(r.find("s")?.apiKey, "new");
	assert.equal(r.remove("s"), true);
	assert.equal(r.find("s"), undefined);
});

test("needsKey is true for a session model without a key until one is supplied", () => {
	const r = createRegistry([model("static-a", "")]);
	r.add(model("s", ""));
	assert.equal(r.needsKey("s"), true);
	r.setKey("s", "k");
	assert.equal(r.needsKey("s"), false);
	assert.equal(r.needsKey("static-a"), false);
});

test("list puts static models first without duplicates", () => {
	const r = createRegistry([model("a"), model("b")]);
	r.add(model("c"));
	assert.deepEqual(r.list().map((m) => m.name), ["a", "b", "c"]);
	assert.equal(r.isSession("c"), true);
	assert.equal(r.isSession("a"), false);
});

test("keyError says a session model needs its key again, and is silent otherwise", () => {
	const r = createRegistry([model("static-a")]);
	r.add(model("s", ""));
	assert.equal(keyError(r, "s"), "needs key again");
	assert.equal(keyError(r, "static-a"), undefined);
	r.setKey("s", "k");
	assert.equal(keyError(r, "s"), undefined);
});
