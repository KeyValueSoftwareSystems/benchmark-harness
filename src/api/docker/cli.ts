import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const docker = (...args: string[]) => promisify(execFile)("docker", args).then((r) => r.stdout.trim());
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Put on every container a job creates so leftovers can be found after a crash. */
export const JOB_LABEL = "bench.job";

/** Removes containers left behind by a previous API instance. */
export async function sweep() {
	const ids = await docker("ps", "-aq", "--filter", `label=${JOB_LABEL}`);
	if (!ids) return;
	const list = ids.split("\n");
	await docker("rm", "-f", ...list);
	console.log(`[docker] removed ${list.length} leftover container(s)`);
}
