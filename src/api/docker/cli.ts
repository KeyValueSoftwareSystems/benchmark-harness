import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { API_CONTAINER_NAME } from "../config.ts";

export const docker = (...args: string[]) => promisify(execFile)("docker", args).then((r) => r.stdout.trim());
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Put on every container a job creates so leftovers can be found after a crash. */
export const JOB_LABEL = "bench.job";
export const AGENT_CONTAINER_PREFIX = "agent-job-";
export const PAA_CONTAINER_PREFIX = "paa-job-";
export const PA_JOB_NETWORK_PREFIX = "pa-job-";

/** Removes containers, compose projects and per-job networks left behind by a previous API instance. */
export async function sweep() {
	const labels = await docker("ps", "-a", "--format", '{{.Label "com.docker.compose.project"}}');
	for (const project of new Set(labels.split("\n").filter((p) => p.startsWith("job-")))) {
		await docker("compose", "-p", project, "down", "-v", "--remove-orphans");
		console.log(`[docker] removed leftover compose project ${project}`);
	}
	const ids = await docker("ps", "-aq", "--filter", `label=${JOB_LABEL}`);
	if (ids) {
		const list = ids.split("\n");
		await docker("rm", "-f", ...list);
		console.log(`[docker] removed ${list.length} leftover container(s)`);
	}
	// Docker won't remove a network with containers attached, so this runs after the containers are gone
	// and detaches the api itself first.
	const networks = (await docker("network", "ls", "--format", "{{.Name}}")).split("\n").filter((n) => n.startsWith(PA_JOB_NETWORK_PREFIX));
	for (const network of networks) {
		await docker("network", "disconnect", "-f", network, API_CONTAINER_NAME).catch(() => {});
		await docker("network", "rm", network)
			.then(() => console.log(`[docker] removed leftover network ${network}`))
			.catch((err) => console.error(`[docker] could not remove leftover network ${network}: ${err}`));
	}
}
