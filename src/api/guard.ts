import type { RequestHandler } from "express";

/** Routes called by job containers; they carry no management key. Everything else is a management route. */
const AGENT_ROUTES: [method: string | undefined, path: RegExp][] = [
	["POST", /^\/register$/],
	["GET", /^\/jobs\/[^/]+\/context$/],
	["POST", /^\/jobs\/[^/]+\/exchanges$/],
	["GET", /^\/jobs\/[^/]+\/result-token$/],
	["POST", /^\/jobs\/[^/]+\/result$/],
	[undefined, /^\/llm\//],
];

export const isAgentRoute = (method: string, path: string) =>
	AGENT_ROUTES.some(([m, re]) => (!m || m === method) && re.test(path));

/**
 * Mounted before every router, so the check doesn't depend on router order. Agent routes are open (they check
 * their own job tokens); requests from a job network may use nothing else; every other request needs `mgmtKey`
 * as a bearer token or X-Mgmt-Key header.
 */
export function createGuard({ mgmtKey, isJobNetwork }: { mgmtKey: string; isJobNetwork(localAddress: string): boolean }): RequestHandler {
	return (req, res, next) => {
		if (isAgentRoute(req.method, req.path)) return next();
		if (isJobNetwork(req.socket.localAddress?.replace(/^::ffff:/, "") ?? "")) {
			return void res.status(403).json({ error: "forbidden: job containers may only use agent routes" });
		}
		const auth = req.headers.authorization ?? "";
		const header = req.headers["x-mgmt-key"];
		if (auth === `Bearer ${mgmtKey}` || header === mgmtKey) return next();
		res.status(403).json({ error: "forbidden: management key required" });
	};
}
