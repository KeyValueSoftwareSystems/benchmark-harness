import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { RESOURCES_DIR } from "../config.ts";
import { withAgent } from "../docker/agent.ts";
import type { Benchmark } from "./types.ts";

const WORLDS_DIR = path.join(RESOURCES_DIR, "pa", "worlds");
/** Where agent-side world files land inside the PI agent container. */
const AGENT_WORLD_DIR = "/pa/world";

// ---------------------------------------------------------------------------
// Types — only the fields we actually read from world.yaml / persona.json
// ---------------------------------------------------------------------------

interface WorldPrompt {
	text: string;
	language: string;
}

interface World {
	task_id: string;
	task_name: string;
	prompt: WorldPrompt;
	execution_date: string;
	environment: { timeout_seconds: number; max_turns: number };
}

interface Persona {
	persona_id: string;
	name: string;
	email: string;
	role: string;
	organization: string;
	communication_style: string;
	domain_knowledge: string[];
	execution_date: string;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const worldDir = (id: string) => path.join(WORLDS_DIR, id);

async function loadWorld(id: string): Promise<World> {
	if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid world id ${id}`);
	const raw = await readFile(path.join(worldDir(id), "world.yaml"), "utf8");
	return YAML.parse(raw) as World;
}

async function loadPersona(id: string): Promise<Persona> {
	return JSON.parse(await readFile(path.join(worldDir(id), "persona.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Build the PI agent prompt
// ---------------------------------------------------------------------------

function buildPersonaPrompt(persona: Persona, world: World): string {
	return [
		`You are ${persona.name}, ${persona.role} at ${persona.organization}.`,
		`Your email is ${persona.email}.`,
		`Today's date is ${world.execution_date}.`,
		"",
		"You have a personal assistant (PA) that you communicate with through the ask_paa tool.",
		"You should interact with your assistant the way a real person would — be natural,",
		`use a ${persona.communication_style} communication style.`,
		"",
		"## Your Goal",
		"",
		world.prompt.text,
		"",
		"## Instructions",
		"",
		"1. Use the `ask_paa` tool to send messages to your assistant.",
		"2. Evaluate the assistant's responses — ask follow-up questions if the response",
		"   is incomplete, unclear, or does not fully address your request.",
		"3. When you are satisfied with the assistant's work (or you determine the assistant",
		"   cannot complete the task), call `end_conversation` with the outcome and reason.",
		"4. Do NOT try to do the work yourself — you are delegating to your assistant.",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Benchmark implementation
// ---------------------------------------------------------------------------

export const pa: Benchmark = {
	name: "pa",
	concurrency: 2,

	async parse({ world }) {
		if (typeof world !== "string") return { error: "world is required" };
		try {
			const ids = world === "all" ? (await readdir(WORLDS_DIR)).sort() : [world];
			return await Promise.all(
				ids.map(async (id) => {
					const [w, p] = await Promise.all([loadWorld(id), loadPersona(id)]);
					return { prompt: buildPersonaPrompt(p, w), params: { world: id } };
				}),
			);
		} catch {
			return { error: `unknown world ${world}` };
		}
	},

	async context(job) {
		const id = job.params?.world ?? "";
		const world = await loadWorld(id);
		return {
			benchmark: "pa",
			world_id: id,
			assistant_endpoint: process.env.PAA_ENDPOINT ?? "http://paa:8090/chat",
			conversation_id: `conv-${job.id}`,
			max_exchanges: Number(process.env.PAA_MAX_EXCHANGES ?? 20),
			max_replies: Number(process.env.PAA_MAX_REPLIES ?? 50),
			execution_date: world.execution_date,
			task_name: world.task_name,
		};
	},

	async run(job, ctx) {
		const id = job.params?.world ?? "";
		const dir = worldDir(id);
		console.log(`[pa] job-${job.id}: starting world ${id}`);

		return await withAgent(job, ctx, (agent) => agent.run(job.prompt), {
			files: { from: dir, to: AGENT_WORLD_DIR },
		});
	},
};
