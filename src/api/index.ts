import os from "node:os";
import express from "express";
import { Redis } from "ioredis";
import type { ModelConfig } from "../shared/types.ts";
import { redact } from "../shared/types.ts";
import { runAgent, sweep } from "./containers.ts";
import { createJob, getJob, isCancelRequested, listJobs, requestCancel, setStatus } from "./jobs.ts";
import { enqueue, startWorker } from "./queue.ts";

const PORT = Number(process.env.PORT ?? 3000);
const MODELS: ModelConfig[] = JSON.parse(process.env.MODELS ?? "[]");
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 2);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 30 * 60_000);
/** Benchmarks whose agent containers the API provisions per job (image `bench/<name>`). */
const PROVISIONED = new Set(["minimal"]);

const redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");

interface Replica {
	url: string;
	model: ModelConfig;
}
const registry = new Map<string, Replica[]>();

const app = express();
app.use(express.json());

app.post("/register", async (req, res) => {
	const { benchmark, url, jobId } = req.body ?? {};
	if (typeof jobId === "string") {
		const job = await getJob(redis, jobId);
		const model = MODELS.find((m) => m.name === job?.model);
		if (!model) return void res.status(404).json({ error: "unknown job" });
		return void res.json({ model });
	}
	if (typeof benchmark !== "string" || typeof url !== "string") {
		return void res.status(400).json({ error: "benchmark and url are required" });
	}
	const replicas = registry.get(benchmark) ?? [];
	registry.set(benchmark, replicas);
	let replica = replicas.find((r) => r.url === url);
	if (!replica) {
		const model = MODELS.find((m) => !replicas.some((r) => r.model.name === m.name));
		if (!model) return void res.status(409).json({ error: "all models already assigned" });
		replica = { url, model };
		replicas.push(replica);
	}
	res.json({ model: replica.model });
});

app.get("/benchmarks", (_req, res) => {
	res.json(
		Object.fromEntries(
			[...registry].map(([name, rs]) => [name, rs.map((r) => ({ url: r.url, model: redact(r.model) }))]),
		),
	);
});

app.get("/benchmarks/:benchmark/status", async (req, res) => {
	const replicas = registry.get(req.params.benchmark);
	if (!replicas) return void res.status(404).json({ error: "unknown benchmark" });
	res.json(
		await Promise.all(
			replicas.map(async (r) => {
				try {
					return { name: r.model.name, ...(await (await fetch(`${r.url}/state`)).json()) };
				} catch (err) {
					return { name: r.model.name, status: "unreachable", error: String(err) };
				}
			}),
		),
	);
});

// Dispatch the prompt to the selected replicas one after the other.
app.post("/benchmarks/:benchmark/run", async (req, res) => {
	const replicas = registry.get(req.params.benchmark);
	if (!replicas?.length) return void res.status(404).json({ error: "no replicas registered for benchmark" });
	const { prompt, models } = req.body ?? {};
	if (typeof prompt !== "string" || !prompt) return void res.status(400).json({ error: "prompt is required" });
	const selected = Array.isArray(models) ? replicas.filter((r) => models.includes(r.model.name)) : replicas;
	if (!selected.length) return void res.status(404).json({ error: "no matching models" });

	const results = [];
	for (const r of selected) {
		try {
			const resp = await fetch(`${r.url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt }),
			});
			results.push({ model: r.model.name, replica: r.url, status: resp.status });
		} catch (err) {
			results.push({ model: r.model.name, replica: r.url, status: "unreachable", error: String(err) });
		}
	}
	res.status(202).json({ results });
});

app.post("/jobs", async (req, res) => {
	const { benchmark, prompt, models } = req.body ?? {};
	if (!PROVISIONED.has(benchmark)) return void res.status(404).json({ error: "unknown benchmark" });
	if (typeof prompt !== "string" || !prompt) return void res.status(400).json({ error: "prompt is required" });
	const selected = Array.isArray(models) ? MODELS.filter((m) => models.includes(m.name)) : MODELS;
	if (!selected.length) return void res.status(404).json({ error: "no matching models" });
	const jobs = [];
	for (const m of selected) {
		const job = await createJob(redis, { benchmark, prompt, model: m.name });
		await enqueue(redis, job.id);
		console.log(`[api] job ${job.id} queued (${benchmark}, ${m.name})`);
		jobs.push(job);
	}
	res.status(202).json({ jobs });
});

app.get("/jobs", async (_req, res) => void res.json(await listJobs(redis)));

app.get("/jobs/:id", async (req, res) => {
	const job = await getJob(redis, req.params.id);
	if (!job) return void res.status(404).json({ error: "unknown job" });
	res.json(job);
});

app.post("/jobs/:id/cancel", async (req, res) => {
	const job = await getJob(redis, req.params.id);
	if (!job) return void res.status(404).json({ error: "unknown job" });
	await requestCancel(redis, job.id);
	res.status(202).json({ id: job.id });
});

async function handleJob(id: string) {
	const job = await getJob(redis, id);
	if (!job || job.status === "done" || job.status === "error" || job.status === "cancelled") return;
	if (await isCancelRequested(redis, id)) {
		console.log(`[api] job ${id} cancelled before start`);
		return void (await setStatus(redis, id, "cancelled"));
	}
	await setStatus(redis, id, "provisioning");
	console.log(`[api] job ${id} (${job.benchmark}, ${job.model}) provisioning`);
	const outcome = await runAgent({
		jobId: id,
		benchmark: job.benchmark,
		prompt: job.prompt,
		apiUrl: `http://api:${PORT}`,
		timeoutMs: JOB_TIMEOUT_MS,
		cancelled: () => isCancelRequested(redis, id),
		onRunning: () => setStatus(redis, id, "running"),
	});
	await setStatus(redis, id, outcome.status, outcome.error);
	console.log(`[api] job ${id} ${outcome.status}`);
}

await sweep().catch((err) => console.error(`[api] startup sweep failed: ${err}`));
void startWorker(redis, handleJob, { concurrency: MAX_CONCURRENCY, consumer: os.hostname() });

app.listen(PORT, () => console.error(`[api] listening on ${PORT}, ${MODELS.length} model(s) configured`));
