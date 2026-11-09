import { randomUUID } from "node:crypto";
import { Router } from "express";
import { benchmarks } from "../benchmarks/index.ts";
import type { JobInput } from "../benchmarks/types.ts";
import { keyError, registry } from "../models/registry.ts";
import { createJob, getJob, listJobs, requestCancel } from "../queue/store.ts";
import { enqueue } from "../queue/worker.ts";
import { redis } from "../redis.ts";

export const jobs = Router();

jobs.post("/jobs", async (req, res) => {
	const { benchmark: name, models, challenges } = req.body ?? {};
	const benchmark = benchmarks.get(name);
	if (!benchmark) return void res.status(404).json({ error: "unknown benchmark" });
	const selected = Array.isArray(models) ? registry.list().filter((m) => models.includes(m.name)) : registry.list();
	if (!selected.length) return void res.status(404).json({ error: "no matching models" });
	const blocked = selected.find((m) => keyError(registry, m.name));
	if (blocked) return void res.status(409).json({ error: `${blocked.name}: ${keyError(registry, blocked.name)}` });

	// `challenges` picks a subset (one job each); without it the benchmark's own body rules apply.
	let input: JobInput[] | { error: string };
	if (challenges === undefined) input = await benchmark.parse(req.body);
	else {
		const known = await benchmark.challenges?.();
		if (!known || !Array.isArray(challenges) || !challenges.length || !challenges.every((c) => known.includes(c))) {
			return void res.status(400).json({ error: "challenges must be a non-empty list of this benchmark's challenge ids" });
		}
		const parts = await Promise.all(challenges.map((challenge) => benchmark.parse({ ...req.body, challenge })));
		input = parts.flatMap((p) => ("error" in p ? [] : p));
		const failed = parts.find((p) => "error" in p);
		if (failed && "error" in failed) input = failed;
	}
	if ("error" in input) return void res.status(400).json({ error: input.error });

	const runId = randomUUID();
	const created = [];
	for (const item of input) {
		for (const m of selected) {
			const job = await createJob(redis, { benchmark: name, ...item, params: { ...item.params, runId }, model: m.name });
			await enqueue(redis, name, job.id);
			console.log(`[api] job ${job.id} queued (${name}, ${m.name})`);
			created.push(job);
		}
	}
	res.status(202).json({ runId, jobs: created });
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
