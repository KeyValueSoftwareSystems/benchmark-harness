import { Router } from "express";
import type { FixtureLoader } from "./types.ts";

export function configRoutes(load: FixtureLoader): Router {
	const r = Router();
	const integrations = (): any[] => load("config/integrations.json");

	r.post("/config/integrations", (req, res) => {
		const all = integrations();
		const { status } = req.body;
		const filtered = status
			? all.filter((i) => i.status === status)
			: all;
		res.json({
			total: filtered.length,
			integrations: filtered.map(
				({ secrets: _, credentials: __, ...rest }) => rest,
			),
		});
	});

	r.post("/config/integrations/get", (req, res) => {
		const { integration_id } = req.body;
		if (!integration_id) return res.json({ error: "integration_id required" });
		const i = integrations().find(
			(i) => i.integration_id === integration_id,
		);
		if (!i) return res.status(404).json({ error: "integration not found" });
		res.json(i);
	});

	return r;
}
