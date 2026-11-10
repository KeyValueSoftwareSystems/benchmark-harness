import { readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import YAML from "yaml";
import type { FixtureLoader } from "./types.ts";

/**
 * Scenario clock service. Returns the execution_date from world.yaml
 * so the PAA uses the scenario's date instead of the container's system clock.
 */
export function datetimeRoutes(_load: FixtureLoader): Router {
	const r = Router();

	r.post("/datetime", (_req, res) => {
		const worldDir = process.env.WORLD_DIR;
		if (!worldDir) return res.json({ error: "WORLD_DIR not set" });
		try {
			const world = YAML.parse(readFileSync(path.join(worldDir, "world.yaml"), "utf8"));
			const execDate = world.execution_date ?? new Date().toISOString().slice(0, 10);
			res.json({ current_date: execDate, current_time: "09:00:00", timezone: "America/New_York" });
		} catch {
			res.json({ current_date: new Date().toISOString().slice(0, 10), current_time: "09:00:00", timezone: "UTC" });
		}
	});

	return r;
}
