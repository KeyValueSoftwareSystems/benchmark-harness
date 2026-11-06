import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function schedulerRoutes(load: FixtureLoader): Router {
	const r = Router();
	const jobs = (): any[] => load("scheduler/jobs.json");

	r.post("/scheduler/jobs", (req, res) => {
		const all = jobs();
		const { status, enabled, tag } = req.body;
		let filtered = all;
		if (status) filtered = filtered.filter((j) => j.last_status === status);
		if (enabled !== undefined)
			filtered = filtered.filter((j) => j.enabled === enabled);
		if (tag)
			filtered = filtered.filter(
				(j) => j.tags && j.tags.includes(tag),
			);
		res.json({
			total: filtered.length,
			jobs: filtered.map(
				({ action: _, execution_history: __, ...rest }) => rest,
			),
		});
	});

	r.post("/scheduler/jobs/get", (req, res) => {
		const { job_id } = req.body;
		if (!job_id) return res.json({ error: "job_id required" });
		const j = jobs().find((j) => j.job_id === job_id);
		if (!j) return res.status(404).json({ error: "job not found" });
		res.json(j);
	});

	r.post("/scheduler/jobs/create", (req, res) => {
		console.log("[mock-scheduler] create:", req.body.name);
		res.json({ success: true, job_id: `JOB-${Date.now()}` });
	});

	r.post("/scheduler/jobs/update", (req, res) => {
		console.log("[mock-scheduler] update:", req.body.job_id);
		res.json({ success: true });
	});

	r.post("/scheduler/jobs/delete", (req, res) => {
		console.log("[mock-scheduler] delete:", req.body.job_id);
		res.json({ success: true });
	});

	r.post("/scheduler/jobs/history", (req, res) => {
		const { job_id } = req.body;
		if (!job_id) return res.json({ error: "job_id required" });
		const j = jobs().find((j) => j.job_id === job_id);
		if (!j) return res.status(404).json({ error: "job not found" });
		const history = j.execution_history || [];
		const limit = Number(req.body.limit ?? 10);
		res.json({
			total: history.length,
			entries: history.slice(0, limit),
		});
	});

	return r;
}
