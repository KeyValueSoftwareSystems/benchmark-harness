import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSelection } from "../src/pa/selection.ts";

const task = (worldId: string, bucket = "work") => ({
	bucket,
	split: "benchmark",
	bundle: "tool",
	taskId: `T_${worldId}`,
	persona: "T05",
	worldId,
	translated: false,
});

function dirWith(name: string, content: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "sel-"));
	writeFileSync(join(dir, `${name}.json`), typeof content === "string" ? content : JSON.stringify(content));
	return dir;
}

test("a valid manifest loads with its tasks and extra fields ignored", async () => {
	const dir = dirWith("everyday", { name: "everyday", rules: {}, tasks: [task("w1"), task("w2", "home_family")] });
	const manifest = await loadSelection("everyday", dir);
	assert.equal(manifest.name, "everyday");
	assert.deepEqual(manifest.tasks.map((t) => t.worldId), ["w1", "w2"]);
	assert.equal(manifest.tasks[1].bucket, "home_family");
});

test("a name with a path separator is rejected before any file is read", async () => {
	const dir = dirWith("everyday", { name: "everyday", tasks: [task("w1")] });
	await assert.rejects(loadSelection("../everyday", dir), /invalid selection/);
	await assert.rejects(loadSelection("a/b", dir), /invalid selection/);
});

test("a missing selection file is an error", async () => {
	const dir = dirWith("everyday", { name: "everyday", tasks: [task("w1")] });
	await assert.rejects(loadSelection("other", dir));
});

test("a duplicate worldId is rejected", async () => {
	const dir = dirWith("dup", { name: "dup", tasks: [task("w1"), task("w1", "personal_life")] });
	await assert.rejects(loadSelection("dup", dir), /duplicate worldId w1/);
});

test("an unknown bucket is rejected", async () => {
	const dir = dirWith("bucket", { name: "bucket", tasks: [task("w1", "hobbies")] });
	await assert.rejects(loadSelection("bucket", dir), /unknown bucket hobbies/);
});

test("a manifest without tasks is rejected", async () => {
	const dir = dirWith("empty", { name: "empty", tasks: [] });
	await assert.rejects(loadSelection("empty", dir), /no tasks/);
});

test("a file that is not JSON is rejected", async () => {
	const dir = dirWith("broken", "{not json");
	await assert.rejects(loadSelection("broken", dir), SyntaxError);
});
