import { Router } from "express";
import { RecordStore, type FixtureRecord } from "./record-store.ts";
import type { FixtureLoader } from "./types.ts";

const DEFAULT_PRIORITY = "medium";
const NEW_TASK_STATUS = "pending";

export function todoRoutes(load: FixtureLoader): Router {
	const r = Router();
	const store = new RecordStore<FixtureRecord>(() => load("todo/tasks.json"), ["task_id"], "TODO");

	r.post("/todo/tasks", (req, res) => {
		const all = store.all();
		const { status } = req.body;
		const filtered = status ? all.filter((t) => t.status === status) : all;
		res.json({ total: filtered.length, tasks: filtered });
	});

	r.post("/todo/tasks/create", (req, res) => {
		const { title, description, priority, due_date } = req.body;
		const task = store.create({
			title,
			description: description ?? "",
			priority: priority ?? DEFAULT_PRIORITY,
			due_date: due_date ?? null,
			status: NEW_TASK_STATUS,
			tags: [],
		});
		res.json({ success: true, task_id: task.task_id });
	});

	r.post("/todo/tasks/update", (req, res) => {
		const { task_id, ...changes } = req.body;
		if (!store.update(task_id, changes)) return res.status(404).json({ success: false, error: "task not found" });
		res.json({ success: true });
	});

	r.post("/todo/tasks/delete", (req, res) => {
		if (!store.remove(req.body.task_id)) return res.status(404).json({ success: false, error: "task not found" });
		res.json({ success: true });
	});

	return r;
}
