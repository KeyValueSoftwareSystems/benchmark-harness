import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RESOURCES_DIR } from "../config.ts";
import { withAgent } from "../docker/agent.ts";
import type { Benchmark } from "./types.ts";

const TASKS_DIR = path.join(RESOURCES_DIR, "browser", "tasks");
const FORMAT = "\n\nWhen you have the answer, call submit_answer with just the answer: a number, as few words as possible, or a comma-separated list. No units or articles unless asked.";

const loadTask = async (id: string) => {
	if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid task id ${id}`);
	return JSON.parse(await readFile(path.join(TASKS_DIR, id, "task.json"), "utf8"));
};

/** An agent container with the Obscura browser MCP tools; optionally a GAIA task to answer. */
export const browser: Benchmark = {
	name: "browser",
	concurrency: 2,

	async parse({ prompt, task }) {
		if (typeof task === "string") {
			try {
				const ids = task === "all" ? (await readdir(TASKS_DIR)).sort() : [task];
				return await Promise.all(ids.map(async (id) => ({ prompt: (await loadTask(id)).prompt + FORMAT, params: { task: id } })));
			} catch {
				return { error: `unknown task ${task}` };
			}
		}
		return typeof prompt === "string" && prompt ? [{ prompt }] : { error: "prompt or task is required" };
	},

	async context(job) {
		const id = job.params?.task;
		return id ? { benchmark: "browser", task: id, ...(await loadTask(id)) } : {};
	},

	run: (job, ctx) => withAgent(job, ctx, (agent) => agent.run(job.prompt)),
};
