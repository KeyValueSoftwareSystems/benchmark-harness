import { Router } from "express";
import { MODELS } from "../config.ts";
import { getJob } from "../queue/store.ts";
import { redis } from "../redis.ts";

/** Endpoints called by provisioned agent containers. */
export const agents = Router();

// An agent started for a job asks which model to use (keeps model keys out of container env).
agents.post("/register", async (req, res) => {
	const { jobId } = req.body ?? {};
	if (typeof jobId !== "string") return void res.status(400).json({ error: "jobId is required" });
	const job = await getJob(redis, jobId);
	const model = MODELS.find((m) => m.name === job?.model);
	if (!model) return void res.status(404).json({ error: "unknown job" });
	res.json({ model });
});
