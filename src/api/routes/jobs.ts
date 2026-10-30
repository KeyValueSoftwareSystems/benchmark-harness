import { Router } from "express";
import { benchmarks } from "../benchmarks/index.ts";
import { MODELS } from "../config.ts";
import { createJob, getJob, listJobs, requestCancel } from "../queue/store.ts";
import { enqueue } from "../queue/worker.ts";
import { redis } from "../redis.ts";

export const jobs = Router();

jobs.post("/jobs", async (req, res) => {
	const { benchmark: name, models } = req.body ?? {};
	const benchmark = benchmarks.get(name);
	if (!benchmark) return void res.status(404).json({ error: "unknown benchmark" });
	const input = await benchmark.parse(req.body);
	if ("error" in input) return void res.status(400).json({ error: input.error });
	const selected = Array.isArray(models) ? MODELS.filter((m) => models.includes(m.name)) : MODELS;
	if (!selected.length) return void res.status(404).json({ error: "no matching models" });

	const created = [];
	for (const item of input) {
		for (const m of selected) {
			const job = await createJob(redis, { benchmark: name, ...item, model: m.name });
			await enqueue(redis, name, job.id);
			console.log(`[api] job ${job.id} queued (${name}, ${m.name})`);
			created.push(job);
		}
	}
	res.status(202).json({ jobs: created });
});

jobs.get("/jobs", async (_req, res) => void res.json(await listJobs(redis)));

jobs.get("/jobs/:id", async (req, res) => {
	const job = await getJob(redis, req.params.id);
	if (!job) return void res.status(404).json({ error: "unknown job" });
	res.json(job);
});

jobs.post("/jobs/:id/cancel", async (req, res) => {
	const job = await getJob(redis, req.params.id);
	if (!job) return void res.status(404).json({ error: "unknown job" });
	await requestCancel(redis, job.id);
	res.status(202).json({ id: job.id });
});
