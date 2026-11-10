import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function todoRoutes(load: FixtureLoader): Router {
	const r = Router();
	const tasks = (): any[] => load("todo/tasks.json");

	r.post("/todo/tasks", (req, res) => {
		const all = tasks();
		const { status } = req.body;
		const filtered = status ? all.filter((t) => t.status === status) : all;
		res.json({ total: filtered.length, tasks: filtered });
	});

	r.post("/todo/tasks/create", (req, res) => {
		console.log("[mock-todo] create:", req.body.title);
		res.json({ success: true, task_id: `TODO-${Date.now()}` });
	});

	r.post("/todo/tasks/update", (req, res) => {
		console.log("[mock-todo] update:", req.body.task_id);
		res.json({ success: true });
	});

	r.post("/todo/tasks/delete", (req, res) => {
		console.log("[mock-todo] delete:", req.body.task_id);
		res.json({ success: true });
	});

	return r;
}
