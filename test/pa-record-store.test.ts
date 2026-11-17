import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { calendarRoutes } from "../src/pa/mock-services/calendar.ts";
import { clawNotionRoutes } from "../src/pa/mock-services/claw_notion.ts";
import { clawObsidianRoutes } from "../src/pa/mock-services/claw_obsidian.ts";
import { meetingRoutes } from "../src/pa/mock-services/meeting.ts";
import { RecordStore } from "../src/pa/mock-services/record-store.ts";
import { todoRoutes } from "../src/pa/mock-services/todo.ts";
import type { FixtureLoader } from "../src/pa/mock-services/types.ts";

interface Item {
	item_id: string;
	label: string;
}

const fixtureItems = (): Item[] => [
	{ item_id: "A-1", label: "one" },
	{ item_id: "A-2", label: "two" },
];

test("created records appear in all() and can be found by their new id", () => {
	const store = new RecordStore<Item>(fixtureItems, ["item_id"], "A");
	const created = store.create({ label: "three" });

	assert.equal(store.all().length, 3);
	assert.equal(store.find(created.item_id)?.label, "three");
	assert.notEqual(created.item_id, "A-1");
});

test("updating a fixture record changes what all() returns for it", () => {
	const store = new RecordStore<Item>(fixtureItems, ["item_id"], "A");

	assert.equal(store.update("A-1", { label: "changed" })?.label, "changed");
	assert.equal(store.all().find((item) => item.item_id === "A-1")?.label, "changed");
	assert.equal(store.update("missing", { label: "x" }), undefined);
});

test("removing a fixture record or a created record takes it out of all()", () => {
	const store = new RecordStore<Item>(fixtureItems, ["item_id"], "A");
	const created = store.create({ label: "three" });

	assert.equal(store.remove("A-2"), true);
	assert.equal(store.remove(created.item_id), true);
	assert.equal(store.remove("A-2"), false);
	assert.deepEqual(store.all().map((item) => item.item_id), ["A-1"]);
});

test("a record can be found by an alternate id field", () => {
	const store = new RecordStore<Record<string, string>>(() => [{ note_id: "N-1", path: "a/b.md" }], ["note_id", "path"], "N");

	assert.equal(store.find("a/b.md")?.note_id, "N-1");
});

async function callRoutes(routerFactory: (load: FixtureLoader) => express.Router, load: FixtureLoader) {
	const app = express();
	app.use(express.json());
	app.use(routerFactory(load));
	const server = app.listen(0);
	const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const post = async (route: string, body: object) => {
		const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: response.status, body: (await response.json()) as any };
	};
	return { post, close: () => server.close() };
}

test("a created todo task shows in the list, updates and deletes", async () => {
	const todo = await callRoutes(todoRoutes, () => []);
	try {
		const { body: created } = await todo.post("/todo/tasks/create", { title: "Call the vet" });
		assert.equal((await todo.post("/todo/tasks", {})).body.total, 1);

		await todo.post("/todo/tasks/update", { task_id: created.task_id, status: "completed" });
		assert.equal((await todo.post("/todo/tasks", { status: "completed" })).body.tasks[0].title, "Call the vet");

		await todo.post("/todo/tasks/delete", { task_id: created.task_id });
		assert.equal((await todo.post("/todo/tasks", {})).body.total, 0);
		assert.equal((await todo.post("/todo/tasks/delete", { task_id: created.task_id })).status, 404);
	} finally {
		todo.close();
	}
});

test("a created calendar event can be fetched and a deleted event no longer lists", async () => {
	const fixture = [{ event_id: "EVT-1", title: "Existing", start_time: "2026-04-01T09:00:00", end_time: "2026-04-01T10:00:00", attendees: [], location: "", recurring: false }];
	const calendar = await callRoutes(calendarRoutes, () => fixture);
	try {
		const { body: created } = await calendar.post("/calendar/events/create", { title: "Dentist", start_time: "2026-04-02T09:00:00", end_time: "2026-04-02T10:00:00" });
		assert.equal((await calendar.post("/calendar/events/get", { event_id: created.event_id })).body.title, "Dentist");

		await calendar.post("/calendar/events/delete", { event_id: "EVT-1" });
		assert.deepEqual((await calendar.post("/calendar/events", {})).body.events.map((event: any) => event.title), ["Dentist"]);
	} finally {
		calendar.close();
	}
});

test("notion pages gain properties and blocks, and archived pages leave the list but stay readable", async () => {
	const fixture = [{ page_id: "P-1", title: "Plan", properties: { status: "Draft" }, blocks: [{ type: "paragraph", text: "a" }] }];
	const notion = await callRoutes(clawNotionRoutes, () => fixture);
	try {
		await notion.post("/claw_notion/pages/update_properties", { page_id: "P-1", properties: { owner: "Sam" } });
		await notion.post("/claw_notion/pages/append_blocks", { page_id: "P-1", blocks: [{ type: "paragraph", text: "b" }] });
		const page = (await notion.post("/claw_notion/pages/get", { page_id: "P-1" })).body;
		assert.deepEqual(page.properties, { status: "Draft", owner: "Sam" });
		assert.equal(page.blocks.length, 2);

		await notion.post("/claw_notion/pages/archive", { page_id: "P-1" });
		assert.equal((await notion.post("/claw_notion/pages", {})).body.total, 0);
		assert.equal((await notion.post("/claw_notion/pages/get", { page_id: "P-1" })).status, 200);
	} finally {
		notion.close();
	}
});

test("obsidian notes can be created, appended to and deleted", async () => {
	const obsidian = await callRoutes(clawObsidianRoutes, () => []);
	try {
		const { body: created } = await obsidian.post("/claw_obsidian/notes/create", { title: "Ideas", content: "first" });
		await obsidian.post("/claw_obsidian/notes/append", { note_id: created.note_id, text: "second" });
		assert.equal((await obsidian.post("/claw_obsidian/notes/get", { note_id: created.note_id })).body.content, "first\nsecond");

		await obsidian.post("/claw_obsidian/notes/delete", { note_id: created.note_id });
		assert.equal((await obsidian.post("/claw_obsidian/notes", {})).body.total, 0);
	} finally {
		obsidian.close();
	}
});

test("meetings move from scheduled to in progress to completed, and terminal meetings reject changes", async () => {
	const meeting = await callRoutes(meetingRoutes, () => []);
	try {
		const { body: created } = await meeting.post("/meeting/create", { topic: "Sync", start_time: "2026-04-02T09:00:00" });
		await meeting.post("/meeting/start", { meeting_id: created.meeting_id });
		assert.equal((await meeting.post("/meeting/get", { meeting_id: created.meeting_id })).body.status, "in_progress");

		await meeting.post("/meeting/end", { meeting_id: created.meeting_id });
		assert.equal((await meeting.post("/meeting/get", { meeting_id: created.meeting_id })).body.status, "completed");
		assert.equal((await meeting.post("/meeting/update", { meeting_id: created.meeting_id, topic: "Late" })).status, 409);
	} finally {
		meeting.close();
	}
});
