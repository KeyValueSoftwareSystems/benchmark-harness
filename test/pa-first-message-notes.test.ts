import assert from "node:assert/strict";
import test from "node:test";
import { withFirstMessageNotes } from "../src/pa/chat-adapter/first-message-notes.ts";

test("the first message gets the clock note, the sandbox note naming the writable folders, then the user's message", () => {
	const text = withFirstMessageNotes("Plan my week.", { executionDate: "2026-04-03", scratchDir: "/opt/data" });
	assert.match(text, /get_current_datetime/);
	assert.match(text, /no internet access\. Only \/tmp and \/opt\/data can be written to/);
	assert.ok(text.endsWith("\n\nPlan my week."));
});

test("the clock note is left out without an execution date, and an empty scratch folder names only /tmp", () => {
	const text = withFirstMessageNotes("Hi", { executionDate: "", scratchDir: "" });
	assert.doesNotMatch(text, /get_current_datetime/);
	assert.match(text, /Only \/tmp can be written to/);
});
