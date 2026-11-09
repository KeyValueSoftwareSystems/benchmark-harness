import { Router } from "express";
import type { Job } from "../../shared/types.ts";

export interface RunsRouterDeps {
	listJobs: () => Promise<Job[]>;
	requestCancel: (id: string) => Promise<unknown>;
	/** Whether each settled job solved its challenge (from the stored results); absent when unknown. */
	correctByJob?: (jobIds: string[]) => Promise<Map<string, boolean | null>>;
}

const UNFINISHED = new Set(["queued", "provisioning", "running"]);

/** A run is the set of jobs one Benchmark click created; they share `params.runId`. */
export function createRunsRouter({ listJobs, requestCancel, correctByJob }: RunsRouterDeps): Router {
	const router = Router();

	router.get("/runs/:runId", async (req, res) => {
		const members = (await listJobs()).filter((j) => j.params?.runId === req.params.runId);
		if (!members.length) return void res.status(404).json({ error: "unknown run" });
		const correct = (await correctByJob?.(members.map((j) => j.id))) ?? new Map<string, boolean | null>();
		res.json({ runId: req.params.runId, jobs: members.map((j) => ({ ...j, correct: correct.get(j.id) ?? null })) });
	});

	router.post("/runs/:runId/cancel", async (req, res) => {
		const members = (await listJobs()).filter((j) => j.params?.runId === req.params.runId);
		if (!members.length) return void res.status(404).json({ error: "unknown run" });
		const open = members.filter((j) => UNFINISHED.has(j.status));
		await Promise.all(open.map((j) => requestCancel(j.id)));
		res.status(202).json({ cancelled: open.map((j) => j.id) });
	});

	return router;
}
