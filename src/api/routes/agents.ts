import { Router } from "express";
import { benchmarks } from "../benchmarks/index.ts";
import { API_URL, MODELS } from "../config.ts";
import { claimContext, getJob } from "../queue/store.ts";
import { redis } from "../redis.ts";

/** Endpoints called by provisioned agent containers. */
export const agents = Router();

// An agent started for a job asks which model to use (keeps model keys out of container env).
// For "proxy" benchmarks (PA), return the LLM proxy URL + job token instead of the real key.
agents.post("/register", async (req, res) => {
	const { jobId } = req.body ?? {};
	if (typeof jobId !== "string") return void res.status(400).json({ error: "jobId is required" });
	const job = await getJob(redis, jobId);
	if (!job) return void res.status(404).json({ error: "unknown job" });
	const model = MODELS.find((m) => m.name === job.model);
	if (!model) return void res.status(404).json({ error: "unknown model" });

	const benchmark = benchmarks.get(job.benchmark);
	if (benchmark?.modelAccess === "proxy") {
		const agentToken = await redis.get(`agent-llm-token:${job.id}`);
		res.json({
			model: {
				...model,
				// pi's Anthropic client appends /v1/messages to baseUrl itself.
				baseUrl: model.api === "anthropic-messages" ? `${API_URL}/llm` : `${API_URL}/llm/v1`,
				apiKey: agentToken ?? "",
			},
		});
	} else {
		res.json({ model });
	}
});

agents.get("/jobs/:id/context", async (req, res) => {
	const job = await getJob(redis, req.params.id);
	const benchmark = job && benchmarks.get(job.benchmark);
	if (!job || !benchmark?.context) return void res.status(404).json({ error: "no context for job" });
	if (!(await claimContext(redis, job.id))) return void res.status(403).json({ error: "context already served" });
	res.json(await benchmark.context(job));
});
