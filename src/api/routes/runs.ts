import { Router } from "express";
import type { Job } from "../../shared/types.ts";

export interface RunsRouterDeps {
	listJobs: () => Promise<Job[]>;
	requestCancel: (id: string) => Promise<unknown>;
}

const UNFINISHED = new Set(["queued", "provisioning", "running"]);

/** A run is the set of jobs one Benchmark click created; they share `params.runId`. */
export function createRunsRouter({ listJobs, requestCancel }: RunsRouterDeps): Router {
	const router = Router();

	router.post("/runs/:runId/cancel", async (req, res) => {
		const members = (await listJobs()).filter((j) => j.params?.runId === req.params.runId);
		if (!members.length) return void res.status(404).json({ error: "unknown run" });
		const open = members.filter((j) => UNFINISHED.has(j.status));
		await Promise.all(open.map((j) => requestCancel(j.id)));
		res.status(202).json({ cancelled: open.map((j) => j.id) });
	});

	return router;
}
