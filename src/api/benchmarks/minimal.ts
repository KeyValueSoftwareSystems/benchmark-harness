import { withAgent } from "../docker/agent.ts";
import type { Benchmark } from "./types.ts";

/** A bare agent container, no target. */
export const minimal: Benchmark = {
	name: "minimal",
	concurrency: 2,
	parse: async ({ prompt }) => (typeof prompt === "string" && prompt ? [{ prompt }] : { error: "prompt is required" }),
	run: (job, ctx) => withAgent(job, ctx, (agent) => agent.run(job.prompt)),
};
