#!/usr/bin/env node
/**
 * Convert CLaw-Anything benchmark tasks into benchmark-harness PA worlds.
 *
 * Usage:
 *   node --experimental-strip-types scripts/pa/convert-claw-tasks.ts \
 *     --claw-dir /path/to/CLaw-Anything \
 *     --tasks T01_T07,T04_T15,... \
 *     [--dry-run]
 *
 * Each task is a directory under CLaw-Anything/benchmark/{tool,skill}/<task_dir>/
 * containing task.yaml, grader.py, and fixtures/.
 *
 * The script produces one world directory per task under resources/pa/worlds/.
 */

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
	options: {
		"claw-dir": { type: "string" },
		tasks: { type: "string" },
		"dry-run": { type: "boolean", default: false },
	},
});

const CLAW_DIR = values["claw-dir"] ?? path.resolve(import.meta.dirname!, "../../..", "CLaw-Anything");
const DRY_RUN = values["dry-run"] ?? false;
const WORLDS_DIR = path.resolve(import.meta.dirname!, "../../resources/pa/worlds");

// ---------------------------------------------------------------------------
// Persona lookup — match persona by task's persona ID prefix (T##)
// ---------------------------------------------------------------------------

interface ClawPersona {
	name: string;
	email: string;
	role: string;
	organization: string;
	communication_style: string;
	domain_knowledge: string[];
}

function loadPersonas(clawDir: string): Map<string, ClawPersona> {
	const dir = path.join(clawDir, "personas");
	const map = new Map<string, ClawPersona>();
	if (!existsSync(dir)) return map;
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
		const raw = YAML.parse(readFileSync(path.join(dir, file), "utf8"));
		const id = raw.persona_id ?? file.replace(/_persona\.yaml$/, "");
		map.set(id, {
			name: raw.name ?? id,
			email: raw.email ?? `${id.toLowerCase().replace(/\s+/g, ".")}@example.com`,
			role: raw.role ?? raw.occupation ?? "Professional",
			organization: raw.organization ?? raw.company ?? "Unknown",
			communication_style: raw.communication_style ?? "professional, clear",
			domain_knowledge: raw.domain_knowledge ?? raw.expertise ?? [],
		});
	}
	return map;
}

/** Find the persona for a task by matching the T## prefix from the task_id. */
function findPersona(taskId: string, personas: Map<string, ClawPersona>): ClawPersona | undefined {
	const prefix = taskId.split("_")[0]; // "T01"
	for (const [id, p] of personas) {
		if (id.toUpperCase().startsWith(prefix.toUpperCase())) return p;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Extract persona identity from fixture email data
// ---------------------------------------------------------------------------

interface ExtractedPersona {
	name: string;
	email: string;
	organization: string;
}

function extractPersonaFromFixtures(fixturesDir: string): ExtractedPersona | null {
	// 1. Find primary email from gmail inbox "to" field
	const inboxPath = path.join(fixturesDir, "gmail", "inbox.json");
	let primaryEmail: string | null = null;
	if (existsSync(inboxPath)) {
		const emails = JSON.parse(readFileSync(inboxPath, "utf8")) as Array<{ to?: string }>;
		const toCounts = new Map<string, number>();
		for (const e of emails) {
			const to = (e.to ?? "").split(",")[0].trim().toLowerCase();
			if (to && to.includes("@")) {
				toCounts.set(to, (toCounts.get(to) ?? 0) + 1);
			}
		}
		if (toCounts.size > 0) {
			primaryEmail = [...toCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
		}
	}

	// 2. Look for self in contacts
	const contactsPath = path.join(fixturesDir, "contacts", "contacts.json");
	let selfContact: Record<string, string> | null = null;
	if (existsSync(contactsPath)) {
		const contacts = JSON.parse(readFileSync(contactsPath, "utf8")) as Array<Record<string, unknown>>;
		for (const c of contacts) {
			if (c.is_self) { selfContact = c as Record<string, string>; break; }
		}
		if (!selfContact && primaryEmail) {
			for (const c of contacts) {
				if ((c.email as string ?? "").toLowerCase() === primaryEmail) {
					selfContact = c as Record<string, string>; break;
				}
			}
		}
	}

	if (!primaryEmail && !selfContact) return null;

	const email = selfContact?.email ?? primaryEmail ?? "";
	const name = selfContact?.name ?? emailToName(email);
	const org = selfContact?.company ?? selfContact?.organization ?? emailToDomain(email);
	return { name, email, organization: org };
}

function emailToName(email: string): string {
	const local = email.split("@")[0];
	return local.replace(/[._]/g, " ").split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function emailToDomain(email: string): string {
	const domain = (email.split("@")[1] ?? "").split(".")[0];
	return domain.replace(/[_-]/g, " ").split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ---------------------------------------------------------------------------
// Task discovery
// ---------------------------------------------------------------------------

interface ClawTask {
	dir: string;
	type: "tool" | "skill";
	yaml: Record<string, unknown>;
}

function discoverTasks(clawDir: string, taskFilter?: string[]): ClawTask[] {
	const tasks: ClawTask[] = [];
	const filterSet = taskFilter ? new Set(taskFilter.map((t) => t.toUpperCase())) : undefined;

	for (const benchType of ["tool", "skill"] as const) {
		const base = path.join(clawDir, "benchmark", benchType);
		if (!existsSync(base)) continue;
		for (const taskDir of readdirSync(base).sort()) {
			const taskYaml = path.join(base, taskDir, "task.yaml");
			if (!existsSync(taskYaml)) continue;
			const raw = YAML.parse(readFileSync(taskYaml, "utf8")) as Record<string, unknown>;
			const taskId = (raw.task_id as string) ?? taskDir;
			const idKey = taskId.split("_").slice(0, 2).join("_").toUpperCase();
			if (filterSet && !filterSet.has(idKey) && !filterSet.has(taskId.toUpperCase())) continue;
			tasks.push({ dir: path.join(base, taskDir), type: benchType, yaml: raw });
		}
	}
	return tasks;
}

// ---------------------------------------------------------------------------
// Service/tool mapping
// ---------------------------------------------------------------------------

// Standard datetime tool added to every world
const DATETIME_TOOL = {
	name: "get_current_datetime",
	description: "Returns the current date and time in the scenario. Use this instead of the system clock.",
	input_schema: { type: "object", properties: {} },
};

const DATETIME_SERVICE = { name: "datetime", port: 9101 };

const DATETIME_ENDPOINT = {
	tool_name: "get_current_datetime",
	url: "http://localhost:9101/datetime",
	method: "POST",
};

// Service ports that duplicate with datetime (9101)
// If any existing service uses 9101, bump datetime to a higher port
function findDatetimePort(services: { name: string; port: number }[]): number {
	const usedPorts = new Set(services.map((s) => s.port));
	let port = 9101;
	while (usedPorts.has(port)) port++;
	return port;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

interface WorldService {
	name: string;
	port: number;
}

interface WorldTool {
	name: string;
	description: string;
	input_schema: Record<string, unknown>;
}

interface ToolEndpoint {
	tool_name: string;
	url: string;
	method: string;
}

function convertTask(task: ClawTask, personas: Map<string, ClawPersona>): {
	worldId: string;
	worldYaml: Record<string, unknown>;
	gradingYaml: Record<string, unknown>;
	personaJson: Record<string, unknown>;
	fixturesSource: string;
} {
	const t = task.yaml;
	const taskId = t.task_id as string;

	// --- Services: strip Python-specific fields ---
	const rawServices = (t.services as Array<Record<string, unknown>>) ?? [];
	const services: WorldService[] = rawServices
		.filter((s) => s.name !== "datetime") // We add our own
		.map((s) => ({ name: s.name as string, port: s.port as number }));

	// Add datetime service
	const dtPort = findDatetimePort(services);
	services.push({ name: "datetime", port: dtPort });

	// --- Tools: rename 'parameters' → 'input_schema' if needed ---
	const rawTools = (t.tools as Array<Record<string, unknown>>) ?? [];
	const tools: WorldTool[] = rawTools.map((tool) => ({
		name: tool.name as string,
		description: tool.description as string,
		input_schema: (tool.input_schema ?? tool.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
	}));
	// Add datetime tool at the beginning
	tools.unshift({ ...DATETIME_TOOL });

	// --- Tool endpoints ---
	const rawEndpoints = (t.tool_endpoints as Array<Record<string, unknown>>) ?? [];
	const endpoints: ToolEndpoint[] = rawEndpoints.map((ep) => ({
		tool_name: ep.tool_name as string,
		url: ep.url as string,
		method: (ep.method as string) ?? "POST",
	}));
	// Add datetime endpoint
	endpoints.unshift({ ...DATETIME_ENDPOINT, url: `http://localhost:${dtPort}/datetime` });

	// --- World YAML ---
	const worldYaml: Record<string, unknown> = {
		task_id: taskId.toUpperCase(),
		task_name: t.task_name,
		category: t.category ?? "general",
		difficulty: t.difficulty ?? "simple",
		prompt: t.prompt,
		execution_date: String(t.execution_date ?? "2026-04-08"),
		tools,
		tool_endpoints: endpoints,
		services,
		environment: t.environment ?? {
			timeout_seconds: 1200,
			max_turns: 100,
			fixtures: [],
		},
	};

	// --- Grading YAML (include all fields present in existing worlds) ---
	const gradingYaml: Record<string, unknown> = {
		task_id: taskId.toUpperCase(),
		scoring_components: t.scoring_components ?? [],
		safety_checks: t.safety_checks ?? [],
		expected_actions: t.expected_actions ?? [],
		judge_rubric: t.judge_rubric ?? "",
		reference_solution: t.reference_solution ?? "",
		primary_dimensions: t.primary_dimensions ?? [],
	};

	// --- Persona JSON (extract identity from fixtures first) ---
	const fixturesSource = path.join(task.dir, "fixtures");
	const extracted = existsSync(fixturesSource) ? extractPersonaFromFixtures(fixturesSource) : null;
	const clawPersona = findPersona(taskId, personas);

	const personaJson = {
		persona_id: taskId,
		name: extracted?.name ?? clawPersona?.name ?? "Alex Morgan",
		email: extracted?.email ?? clawPersona?.email ?? "alex.morgan@example.com",
		role: clawPersona?.role ?? "",
		organization: extracted?.organization ?? clawPersona?.organization ?? "Unknown",
		communication_style: clawPersona?.communication_style ?? "professional, clear",
		domain_knowledge: clawPersona?.domain_knowledge ?? [],
		execution_date: String(t.execution_date ?? "2026-04-08"),
	};

	// World directory name: persona-prefixed lowercase (matches existing convention)
	const personaSlug = (personaJson.name as string)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/(^_|_$)/g, "");
	const worldId = `${personaSlug}_${taskId.toLowerCase()}`;

	return { worldId, worldYaml, gradingYaml, personaJson, fixturesSource };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const personas = loadPersonas(CLAW_DIR);
console.log(`[convert] Loaded ${personas.size} personas from CLaw-Anything`);

const taskFilter = values.tasks?.split(",").map((t) => t.trim()).filter(Boolean);
const tasks = discoverTasks(CLAW_DIR, taskFilter);
console.log(`[convert] Found ${tasks.length} tasks to convert`);

if (!tasks.length) {
	console.error("[convert] No tasks matched. Use --tasks T01_T07,T04_T15,...");
	process.exit(1);
}

let created = 0;
let skipped = 0;

for (const task of tasks) {
	const { worldId, worldYaml, gradingYaml, personaJson, fixturesSource } = convertTask(task, personas);
	const worldDir = path.join(WORLDS_DIR, worldId);
	const agentDir = path.join(worldDir, "agent");

	if (existsSync(worldDir)) {
		console.log(`[convert] SKIP ${worldId} (already exists)`);
		skipped++;
		continue;
	}

	if (DRY_RUN) {
		console.log(`[convert] DRY-RUN ${worldId}`);
		created++;
		continue;
	}

	// Create directories
	mkdirSync(agentDir, { recursive: true });

	// Write world.yaml — quote execution_date to avoid YAML date type
	const worldYamlStr = YAML.stringify(worldYaml)
		.replace(/^(execution_date:\s*)(\d{4}-\d{2}-\d{2})\s*$/m, "$1'$2'");
	writeFileSync(path.join(worldDir, "world.yaml"), worldYamlStr);

	// Write grading.yaml
	writeFileSync(path.join(worldDir, "grading.yaml"), YAML.stringify(gradingYaml));

	// Write persona.json (tabs to match existing format)
	writeFileSync(path.join(agentDir, "persona.json"), JSON.stringify(personaJson, null, "\t") + "\n");

	// Copy fixtures
	if (existsSync(fixturesSource)) {
		cpSync(fixturesSource, path.join(agentDir, "fixtures"), { recursive: true });
	}

	console.log(`[convert] CREATED ${worldId} (${(task.yaml.category as string) ?? "?"}, ${(task.yaml.difficulty as string) ?? "?"})`);
	created++;
}

console.log(`\n[convert] Done: ${created} created, ${skipped} skipped (already existed)`);
