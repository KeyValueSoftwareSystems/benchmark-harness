import type { RequestHandler } from "express";

/**
 * The management side of the API. Mount it after the agent routers (the routes job containers call, which check their
 * own job tokens) and before every management router: whatever it does not follow is open only to the management key.
 * Requests from a job network that reach it are refused, so job containers can use agent routes and nothing else;
 * every other request needs `mgmtKey` as a bearer token or X-Mgmt-Key header.
 */
export function requireManagementKey({ mgmtKey, isJobNetwork }: { mgmtKey: string; isJobNetwork(localAddress: string): boolean }): RequestHandler {
	return (req, res, next) => {
		if (isJobNetwork(req.socket.localAddress?.replace(/^::ffff:/, "") ?? "")) {
			return void res.status(403).json({ error: "forbidden: job containers may only use agent routes" });
		}
		const auth = req.headers.authorization ?? "";
		const header = req.headers["x-mgmt-key"];
		if (auth === `Bearer ${mgmtKey}` || header === mgmtKey) return next();
		res.status(403).json({ error: "forbidden: management key required" });
	};
}
