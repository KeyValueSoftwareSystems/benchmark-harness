import type { RequestHandler } from "express";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * API keys are only accepted over HTTPS or from localhost. Behind a Docker port mapping a browser on the same machine
 * shows up as the bridge address, so a page opened at a localhost URL counts as local too. `ALLOW_INSECURE_KEYS=1` lifts it for a trusted network
 * (the harness API has no authentication of its own).
 */
export const insecureKeyGuard =
	(env: Record<string, string | undefined> = process.env): RequestHandler =>
	(req, res, next) => {
		const secure = req.protocol === "https" || LOOPBACK.has(req.socket.remoteAddress ?? "") || LOCAL_HOSTS.has(req.hostname) || env.ALLOW_INSECURE_KEYS === "1";
		if (secure) return void next();
		res.status(403).json({ error: "API keys are only accepted over HTTPS or from localhost (set ALLOW_INSECURE_KEYS=1 on a trusted network)" });
	};
