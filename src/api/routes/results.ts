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
	/** Returns a fresh one-time token for the job, or undefined if it was already issued. */
	issueToken(id: string): Promise<string | undefined>;
	verifyToken(id: string, token: string): Promise<boolean>;
}) {
	const router = Router();
	// Like /jobs/:id/context: served once, to the extension at startup. Without it a model could post its own verdict.
	router.get("/jobs/:id/result-token", async (req, res) => {
		if (!(await deps.jobExists(req.params.id))) return void res.status(404).json({ error: "unknown job" });
		const token = await deps.issueToken(req.params.id);
		if (!token) return void res.status(403).json({ error: "token already served" });
		res.json({ token });
	});
	router.post("/jobs/:id/result", async (req, res) => {
		if (!(await deps.jobExists(req.params.id))) return void res.status(404).json({ error: "unknown job" });
		const token = req.header("x-result-token") ?? "";
		if (!token || !(await deps.verifyToken(req.params.id, token))) return void res.status(403).json({ error: "invalid result token" });
		const payload = parsePayload(req.body);
		if (!payload) return void res.status(400).json({ error: "invalid result payload" });
		if (!(await deps.saveResult(req.params.id, payload))) return void res.status(409).json({ error: "result already reported" });
		res.status(202).json({ id: req.params.id });
	});
	return router;
}
