import type { ErrorRequestHandler } from "express";

/**
 * Last-resort error handler. Express's default one logs the error, and a body-parser error can carry a snippet of the
 * request body, which may hold an API key. Nothing about the request is logged here or returned.
 */
export const jsonErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
	if (res.headersSent) return void res.end();
	if (err?.type === "entity.parse.failed") return void res.status(400).json({ error: "invalid JSON" });
	console.error(`[api] request failed: ${err instanceof Error ? err.name : "error"}`);
	res.status(500).json({ error: "internal error" });
};
