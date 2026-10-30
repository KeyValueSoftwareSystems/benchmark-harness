import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RESOURCES_DIR } from "../config.ts";
import { withAgent } from "../docker/agent.ts";
import { docker } from "../docker/cli.ts";
import type { Benchmark } from "./types.ts";

const CHALLENGES_DIR = path.join(RESOURCES_DIR, "cyber", "challenges");
/** Where challenge files land inside the agent container. */
const AGENT_FILES_DIR = "/ctf/files";

interface Challenge {
	name: string;
	prompt: string;
	flag: string;
	target: string;
}

const challengeDir = (id: string) => path.join(CHALLENGES_DIR, id);

async function loadChallenge(id: string): Promise<Challenge> {
	if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid challenge id ${id}`);
	return JSON.parse(await readFile(path.join(challengeDir(id), "challenge.json"), "utf8"));
}

/** An agent plus the challenge's own compose project (its target machines), torn down together. */
export const cyber: Benchmark = {
	name: "cyber",
	concurrency: 2,

	async parse({ challenge }) {
		if (typeof challenge !== "string") return { error: "challenge is required" };
		try {
			// "all" runs every imported challenge.
			const ids = challenge === "all" ? (await readdir(CHALLENGES_DIR)).sort() : [challenge];
			return await Promise.all(ids.map(async (id) => ({ prompt: (await loadChallenge(id)).prompt, params: { challenge: id } })));
		} catch {
			return { error: `unknown challenge ${challenge}` };
		}
	},

	async context(job) {
		const id = job.params?.challenge ?? "";
		return { benchmark: "cyber", challenge: id, ...(await loadChallenge(id)), filesDir: AGENT_FILES_DIR };
	},

	async run(job, ctx) {
		const id = job.params?.challenge ?? "";
		const dir = challengeDir(id);
		const project = `job-${job.id}`;
		const compose = (...args: string[]) => docker("compose", "-p", project, "-f", path.join(dir, "target", "compose.yml"), ...args);
		const filesDir = path.join(dir, "files");
		const hasFiles = await access(filesDir).then(() => true, () => false);
		const hasTarget = await access(path.join(dir, "target", "compose.yml")).then(() => true, () => false);

		try {
			console.log(`[cyber] ${project}: starting challenge ${id}`);
			if (hasTarget) await compose("up", "-d", "--build", "--wait");
			return await withAgent(job, ctx, (agent) => agent.run(job.prompt), {
				networks: hasTarget ? [`${project}_default`] : [],
				files: hasFiles ? { from: filesDir, to: AGENT_FILES_DIR } : undefined,
			});
		} finally {
			if (hasTarget) await compose("down", "-v", "--remove-orphans")
				.then(() => console.log(`[cyber] ${project}: challenge removed`))
				.catch((err) => console.error(`[cyber] ${project}: teardown failed: ${err}`));
		}
	},
};
