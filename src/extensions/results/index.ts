import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildPayload, fetchResultToken, postResult, type CollectedState } from "./payload.ts";

/**
 * Benchmark-agnostic result reporter. Any extension that emits `benchmark_result` is covered; a run that emits none
 * still reports its usage with `outcome: null`. The api stores the payload when the job settles.
 */
export default function (pi: ExtensionAPI) {
	const state: CollectedState = { usages: [], turns: 0, startedAt: Date.now(), endedAt: Date.now(), outcome: null };
	let reported = false;
	let token: string | undefined;

	// Served once per job, before the model can run anything, so the model never holds it (it is not in the environment).
	pi.on("session_start", async () => {
		const { API_URL, JOB_ID } = process.env;
		if (!API_URL || !JOB_ID) return;
		token = await fetchResultToken(`${API_URL}/jobs/${JOB_ID}/result-token`);
		if (!token) console.error("[results] no result token; result will not be accepted");
	});

	pi.events.on("benchmark_result", (event: unknown) => {
		state.outcome = (event ?? null) as Record<string, unknown> | null;
	});
	pi.events.on("observability_session", (event: unknown) => {
		const id = (event as { sessionId?: unknown } | undefined)?.sessionId;
		if (typeof id === "string") state.sessionId = id;
	});

	pi.on("agent_start", () => {
		state.startedAt = Date.now();
	});
	pi.on("turn_start", () => {
		state.turns++;
	});
	pi.on("message_end", (event) => {
		const m = event.message;
		if (m.role !== "assistant") return;
		state.usages.push({ input: m.usage.input, output: m.usage.output, cost: m.usage.cost.total });
	});

	pi.on("agent_end", async () => {
		if (reported) return;
		reported = true;
		// Let other extensions' agent_end handlers (which may emit benchmark_result) run first.
		await new Promise((r) => setTimeout(r, 0));
		state.endedAt = Date.now();
		const { API_URL, JOB_ID } = process.env;
		if (!API_URL || !JOB_ID) return void console.error("[results] API_URL or JOB_ID not set; result not reported");
		const ok = await postResult(`${API_URL}/jobs/${JOB_ID}/result`, buildPayload(state), { token });
		console.error(ok ? "[results] result reported" : "[results] could not report result");
	});
}
