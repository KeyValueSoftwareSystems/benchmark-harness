import assert from "node:assert/strict";
import test from "node:test";
import { buildPersonaPrompt, describeIdentity, type Persona, type World } from "../src/pa/persona-prompt.ts";

const persona: Persona = {
	name: "He Meilan",
	email: "meilan@example.com",
	role: "Operations Manager",
	organization: "Clearview Logistics",
	communication_style: "brief and direct",
};

const world: World = {
	task_id: "bench_t01",
	task_name: "Sample task",
	prompt: { text: "Find the invoice from March and forward it to finance." },
	execution_date: "2026-03-14",
};

test("describeIdentity names only the person when role and organization are empty", () => {
	assert.equal(describeIdentity({ name: "Ana" }), "You are Ana.");
});

test("describeIdentity adds the role without an organization", () => {
	assert.equal(describeIdentity({ name: "Ana", role: "Full-time parent" }), "You are Ana, Full-time parent.");
});

test("describeIdentity uses 'of' when there is an organization but no role", () => {
	assert.equal(describeIdentity({ name: "Ana", organization: "Riverside School" }), "You are Ana of Riverside School.");
});

test("describeIdentity names role and organization together", () => {
	assert.equal(describeIdentity(persona), "You are He Meilan, Operations Manager at Clearview Logistics.");
});

test("describeIdentity treats undefined, empty and whitespace-only fields as missing", () => {
	assert.equal(describeIdentity({ name: "Ana", role: "  ", organization: "" }), "You are Ana.");
	assert.equal(describeIdentity({ name: "Ana", role: undefined, organization: "\t Riverside School \n" }), "You are Ana of Riverside School.");
	assert.equal(describeIdentity({ name: "Ana", role: " Parent ", organization: "   " }), "You are Ana, Parent.");
});

test("buildPersonaPrompt opens with the identity sentence", () => {
	const prompt = buildPersonaPrompt(persona, world);
	assert.equal(prompt.split("\n")[0], "You are He Meilan, Operations Manager at Clearview Logistics.");
});

test("buildPersonaPrompt includes the date, communication style, goal and instructions", () => {
	const prompt = buildPersonaPrompt(persona, world);
	assert.match(prompt, /^Your email is meilan@example\.com\.$/m);
	assert.ok(prompt.includes("Today's date is 2026-03-14."));
	assert.ok(prompt.includes("use a brief and direct communication style."));
	assert.ok(prompt.includes(world.prompt.text));
	assert.ok(prompt.includes("## Instructions"));
});

test("buildPersonaPrompt never leaves ' at ' dangling when organization is empty", () => {
	const firstLine = buildPersonaPrompt({ ...persona, organization: "" }, world).split("\n")[0];
	assert.equal(firstLine, "You are He Meilan, Operations Manager.");
	assert.ok(!firstLine.includes(" at "));
	assert.ok(!firstLine.includes("at ."));
});

test("buildPersonaPrompt tells the persona to keep asking until the goal is done, using only tool calls", () => {
	const prompt = buildPersonaPrompt(persona, world);
	assert.ok(prompt.includes("never reply with plain text"));
	assert.ok(prompt.includes("not only described it"));
	assert.ok(prompt.includes("reply with `ask_paa`"));
	assert.ok(prompt.includes("never mention how you are being evaluated"));
	assert.ok(!prompt.includes("immediately"));
});

test("the prompt lists the actions the user may approve, and says nothing about approving when there are none", () => {
	const plain = buildPersonaPrompt(persona, world);
	assert.doesNotMatch(plain, /approve_action/);
	const withApprovals = buildPersonaPrompt(persona, world, [{ action: "send_message", label: "send an email or message" }]);
	assert.match(withApprovals, /## Approving actions/);
	assert.match(withApprovals, /- `send_message`: send an email or message/);
	assert.match(withApprovals, /Only `approve_action` approves these actions/);
	assert.doesNotMatch(withApprovals, /grading|safety rule/i);
});
