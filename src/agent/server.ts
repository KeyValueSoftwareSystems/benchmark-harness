import express from "express";
import type { ModelConfig, ReplicaStatus } from "../shared/types.ts";
import { redact } from "../shared/types.ts";
import { createSession } from "./config.ts";

const PORT = Number(process.env.PORT ?? 8080);
const API_URL = process.env.API_URL ?? "http://api:3000";
const BENCHMARK = process.env.BENCHMARK ?? "minimal";
const JOB_ID = process.env.JOB_ID;
if (!JOB_ID) throw new Error("JOB_ID is required: agents are started by the api for a job");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function register(): Promise<ModelConfig> {
	for (let delay = 500; ; delay = Math.min(delay * 2, 5000)) {
		try {
			const res = await fetch(`${API_URL}/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jobId: JOB_ID }),
			});
			if (res.ok) return ((await res.json()) as { model: ModelConfig }).model;
			console.error(`[agent] register failed: ${res.status}`);
		} catch (err) {
			console.error(`[agent] register error: ${err}`);
		}
		await sleep(delay);
	}
}

const model = await register();
console.error(`[agent] registered as ${model.name}`);
const runtime = await createSession(model);
// Fires session_start so extensions (e.g. observability) initialise.
await runtime.session.bindExtensions({ onError: (e) => console.error(`[agent] extension error: ${JSON.stringify(e)}`) });

let status: ReplicaStatus = "idle";
let lastError: string | undefined;

const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => void res.json({ ok: true }));
app.get("/state", (_req, res) => void res.json({ status, model: redact(model), error: lastError }));

app.post("/run", (req, res) => {
	const prompt = req.body?.prompt;
	if (typeof prompt !== "string" || !prompt) return void res.status(400).json({ error: "prompt is required" });
	if (status === "running") return void res.status(409).json({ error: "already running" });
	status = "running";
	lastError = undefined;
	runtime.session
		.prompt(prompt)
		.then(() => void (status = "done"))
		.catch((err: unknown) => {
			status = "error";
			lastError = String(err);
			console.error(`[agent] run failed: ${err}`);
		});
	res.status(202).json({ status });
});

// Fires session_shutdown so observability flushes its spans before the container goes away.
process.on("SIGTERM", () => {
	runtime
		.dispose()
		.catch((err) => console.error(`[agent] shutdown failed: ${err}`))
		.finally(() => process.exit(0));
});

app.listen(PORT, () => console.error(`[agent] ${BENCHMARK}/${model.name} listening on ${PORT}`));
