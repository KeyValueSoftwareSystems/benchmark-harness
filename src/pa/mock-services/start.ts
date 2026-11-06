#!/usr/bin/env node
/**
 * Start mock services for one PA benchmark world.
 *
 * Reads the world directory from WORLD_DIR env var, loads world.yaml
 * to get the services list, and starts one Express server per service.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import YAML from "yaml";

import { gmailRoutes } from "./gmail.ts";
import { calendarRoutes } from "./calendar.ts";
import { todoRoutes } from "./todo.ts";
import { contactsRoutes } from "./contacts.ts";
import { financeRoutes } from "./finance.ts";
import { notesRoutes } from "./notes.ts";
import { kbRoutes } from "./kb.ts";
import { helpdeskRoutes } from "./helpdesk.ts";
import { inventoryRoutes } from "./inventory.ts";
import { rssRoutes } from "./rss.ts";
import { crmRoutes } from "./crm.ts";
import { configRoutes } from "./config.ts";
import { schedulerRoutes } from "./scheduler.ts";
import { workmailRoutes } from "./workmail.ts";
import { clawNotionRoutes } from "./claw_notion.ts";
import { clawObsidianRoutes } from "./claw_obsidian.ts";
import { meetingRoutes } from "./meeting.ts";
import { clawZoteroRoutes } from "./claw_zotero.ts";
import { clawSlackRoutes } from "./claw_slack.ts";
import { clawWechatRoutes } from "./claw_wechat.ts";
import { sheetRoutes } from "./sheet.ts";
import { slideRoutes } from "./slide.ts";
import { mcpRouter, type ToolDef, type ToolEndpoint } from "./mcp.ts";
import type { FixtureLoader } from "./types.ts";

const ROUTE_FACTORIES: Record<string, (load: FixtureLoader) => express.Router> =
	{
		gmail: gmailRoutes,
		calendar: calendarRoutes,
		todo: todoRoutes,
		contacts: contactsRoutes,
		finance: financeRoutes,
		notes: notesRoutes,
		kb: kbRoutes,
		helpdesk: helpdeskRoutes,
		inventory: inventoryRoutes,
		rss: rssRoutes,
		crm: crmRoutes,
		config: configRoutes,
		scheduler: schedulerRoutes,
		workmail: workmailRoutes,
		claw_notion: clawNotionRoutes,
		claw_obsidian: clawObsidianRoutes,
		meeting: meetingRoutes,
		claw_zotero: clawZoteroRoutes,
		claw_slack: clawSlackRoutes,
		claw_wechat: clawWechatRoutes,
		sheet: sheetRoutes,
		slide: slideRoutes,
	};

function createFixtureLoader(worldDir: string): FixtureLoader {
	const fixturesDir = path.join(worldDir, "fixtures");
	return (relativePath: string) => {
		const fullPath = path.join(fixturesDir, relativePath);
		try {
			return JSON.parse(readFileSync(fullPath, "utf8"));
		} catch {
			return [];
		}
	};
}

interface Service {
	name: string;
	port: number;
}

async function main() {
	const worldDir = process.env.WORLD_DIR;
	if (!worldDir) {
		console.error("WORLD_DIR is required");
		process.exit(1);
	}

	const worldYaml = path.join(worldDir, "world.yaml");
	const world = YAML.parse(readFileSync(worldYaml, "utf8"));
	const services: Service[] = world.services || [];
	const tools: ToolDef[] = world.tools || [];
	const toolEndpoints: ToolEndpoint[] = world.tool_endpoints || [];

	if (services.length === 0) {
		console.error("No services found in world.yaml");
		process.exit(1);
	}

	const load = createFixtureLoader(path.join(worldDir, "agent"));

	const started: Promise<void>[] = [];

	for (const svc of services) {
		const factory = ROUTE_FACTORIES[svc.name];
		if (!factory) {
			console.warn(`[mock] No route factory for service: ${svc.name}`);
			continue;
		}

		const app = express();
		app.use(express.json());
		app.use(factory(load));

		const endpoints = toolEndpoints.filter((e) => new URL(e.url).port === String(svc.port));
		const names = new Set(endpoints.map((e) => e.tool_name));
		app.use(mcpRouter(svc.name, tools.filter((t) => names.has(t.name)), endpoints));

		const promise = new Promise<void>((resolve) => {
			app.listen(svc.port, () => {
				console.log(`[mock] ${svc.name} listening on :${svc.port}`);
				resolve();
			});
		});
		started.push(promise);
	}

	await Promise.all(started);
	console.log(`[mock] All ${started.length} services started`);
}

main().catch((err) => {
	console.error("[mock] Fatal:", err);
	process.exit(1);
});
