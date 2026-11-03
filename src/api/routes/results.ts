import { Router } from "express";
import type { ResultPayload } from "../../shared/results.ts";

const METRIC_KEYS = ["turns", "durationMs", "inputTokens", "outputTokens", "costUsd"] as const;

function parsePayload(body: unknown): ResultPayload | undefined {
	const b = body as Record<string, unknown> | null;
	const metrics = b?.metrics as Record<string, unknown> | undefined;
	if (!b || !metrics || typeof metrics !== "object") return undefined;
	if (!METRIC_KEYS.every((k) => typeof metrics[k] === "number" && Number.isFinite(metrics[k] as number))) return undefined;
	const outcome = b.outcome ?? null;
	if (outcome !== null && (typeof outcome !== "object" || Array.isArray(outcome))) return undefined;
	const payload: ResultPayload = { outcome: outcome as ResultPayload["outcome"], metrics: metrics as unknown as ResultPayload["metrics"] };
	if (typeof b.sessionId === "string") payload.sessionId = b.sessionId;
	return payload;
}

/** Endpoint called by provisioned agent containers (like /register); only reachable on the internal bench network. */
export function createResultsRouter(deps: {
	jobExists(id: string): Promise<boolean>;
	saveResult(id: string, payload: ResultPayload): Promise<boolean>;
}) {
	const router = Router();
	router.post("/jobs/:id/result", async (req, res) => {
		const payload = parsePayload(req.body);
		if (!payload) return void res.status(400).json({ error: "invalid result payload" });
		if (!(await deps.jobExists(req.params.id))) return void res.status(404).json({ error: "unknown job" });
		if (!(await deps.saveResult(req.params.id, payload))) return void res.status(409).json({ error: "result already reported" });
		res.status(202).json({ id: req.params.id });
	});
	return router;
}
