/**
 * Makes every world expose the scenario clock (`get_current_datetime`), so the
 * assistant never has to rely on the container's system clock. Applied once, when
 * the API copies a world into the assistant container.
 */

import YAML from "yaml";
import type { ToolDef, ToolEndpoint } from "./mock-services/mcp.ts";

/** Port for the clock service in worlds that don't declare one. */
export const SCENARIO_CLOCK_PORT = 9190;
export const SCENARIO_CLOCK_SERVICE = "datetime";
export const SCENARIO_CLOCK_TOOL = "get_current_datetime";

const SCENARIO_CLOCK_PATH = "/datetime";

interface WorldService {
	name: string;
	port: number;
}

interface World {
	services?: WorldService[];
	tools?: ToolDef[];
	tool_endpoints?: ToolEndpoint[];
	[key: string]: unknown;
}

function scenarioClockTool(): ToolDef {
	return {
		name: SCENARIO_CLOCK_TOOL,
		description: "Returns the current date and time in the scenario. Use this instead of the system clock.",
		input_schema: { type: "object", properties: {} },
	};
}

function assertClockPortFree(services: WorldService[]): void {
	const clash = services.find((s) => s.port === SCENARIO_CLOCK_PORT && s.name !== SCENARIO_CLOCK_SERVICE);
	if (clash) throw new Error(`world service "${clash.name}" already uses port ${SCENARIO_CLOCK_PORT}, the scenario clock's port`);
}

/** Returns the world.yaml text with the scenario clock service, tool and endpoint added where missing. */
export function withScenarioClock(worldYamlText: string): string {
	const world: World = YAML.parse(worldYamlText);
	const services = world.services ?? [];
	const tools = world.tools ?? [];
	const endpoints = world.tool_endpoints ?? [];

	assertClockPortFree(services);
	let clock = services.find((s) => s.name === SCENARIO_CLOCK_SERVICE);
	if (!clock) {
		clock = { name: SCENARIO_CLOCK_SERVICE, port: SCENARIO_CLOCK_PORT };
		services.push(clock);
	}
	if (!tools.some((t) => t.name === SCENARIO_CLOCK_TOOL)) tools.push(scenarioClockTool());
	if (!endpoints.some((e) => e.tool_name === SCENARIO_CLOCK_TOOL)) {
		endpoints.push({ tool_name: SCENARIO_CLOCK_TOOL, url: `http://localhost:${clock.port}${SCENARIO_CLOCK_PATH}`, method: "POST" });
	}

	world.services = services;
	world.tools = tools;
	world.tool_endpoints = endpoints;
	return YAML.stringify(world);
}
