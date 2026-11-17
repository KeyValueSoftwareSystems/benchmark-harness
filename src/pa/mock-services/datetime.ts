import { readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import YAML from "yaml";
import type { FixtureLoader } from "./types.ts";

/** Used by worlds that do not set `execution_time` / `utc_offset` in world.yaml. */
export const DEFAULT_EXECUTION_TIME = "09:00:00";
export const DEFAULT_UTC_OFFSET = "+00:00";

interface ClockWorld {
	execution_date?: unknown;
	execution_time?: unknown;
	utc_offset?: unknown;
}

export interface ScenarioNow {
	current_date: string;
	current_time: string;
	timezone: string;
}

const textOr = (value: unknown, fallback: string): string => (typeof value === "string" && value ? value : fallback);

/** The scenario's date and time of day, and the user's UTC offset (for example `UTC+01:00`). */
export function scenarioNow(world: ClockWorld, today: string): ScenarioNow {
	return {
		current_date: textOr(world.execution_date, today),
		current_time: textOr(world.execution_time, DEFAULT_EXECUTION_TIME),
		timezone: `UTC${textOr(world.utc_offset, DEFAULT_UTC_OFFSET)}`,
	};
}

/**
 * Scenario clock service. Returns the date, time and UTC offset from world.yaml
 * so the PAA uses the scenario's clock instead of the container's system clock.
 */
export function datetimeRoutes(_load: FixtureLoader): Router {
	const r = Router();

	r.post("/datetime", (_req, res) => {
		const today = new Date().toISOString().slice(0, 10);
		const worldDir = process.env.WORLD_DIR;
		if (!worldDir) return res.json({ error: "WORLD_DIR not set" });
		try {
			const world = YAML.parse(readFileSync(path.join(worldDir, "world.yaml"), "utf8")) as ClockWorld;
			res.json(scenarioNow(world, today));
		} catch {
			res.json(scenarioNow({}, today));
		}
	});

	return r;
}
