import { Router } from "express";

export interface ReportsRouterDeps {
	baseUrl: string;
	fetchImpl?: typeof fetch;
}

/** Forwards report requests to the report service, so the page talks to one origin. Failures never expose the cause. */
export function createReportsRouter({ baseUrl, fetchImpl = fetch }: ReportsRouterDeps): Router {
	const router = Router();
	const unavailable = (res: import("express").Response) => void res.status(502).json({ error: "report service unavailable" });

	router.post("/reports", async (req, res) => {
		try {
			const up = await fetchImpl(`${baseUrl}/reports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req.body ?? {}), signal: AbortSignal.timeout(120_000) });
			res.status(up.status).type(up.headers.get("content-type") ?? "application/json").send(await up.text());
		} catch {
			unavailable(res);
		}
	});

	router.get("/reports/:id", async (req, res) => {
		try {
			const up = await fetchImpl(`${baseUrl}/reports/${encodeURIComponent(String(req.params.id))}`, { signal: AbortSignal.timeout(30_000) });
			res.status(up.status).type(up.headers.get("content-type") ?? "text/plain").send(await up.text());
		} catch {
			unavailable(res);
		}
	});

	return router;
}
