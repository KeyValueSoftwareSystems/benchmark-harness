import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildPayload, createTokenLoader, postResult, type CollectedState } from "./payload.ts";

/**
 * Benchmark-agnostic result reporter. Any extension that emits `benchmark_result` is covered; a run that emits none
 * still reports its usage with `outcome: null`. The api stores the payload when the job settles.
 *
 * The result is sent once, at `session_shutdown`: by then every `agent_end` handler (including ones that emit
 * `benchmark_result` after an async step) has finished, and the api refuses a second report for a job. The api stops
 * the agent container gracefully before it finalizes the job, so the result is in before the job is stored.
 */
export default function (pi: ExtensionAPI) {
	const state: CollectedState = { usages: [], turns: 0, startedAt: Date.now(), endedAt: Date.now(), outcome: null };
	let ended = false;
	let reported = false;
	let tokens: ReturnType<typeof createTokenLoader> | undefined;

	// Served once per job, before the model can run anything, so the model never holds it (it is not in the environment).
	pi.on("session_start", async () => {
		const { API_URL, JOB_ID } = process.env;
		if (!API_URL || !JOB_ID) return;
		tokens ??= createTokenLoader(`${API_URL}/jobs/${JOB_ID}/result-token`);
		if (!(await tokens.load())) console.error("[results] no result token; result will not be accepted");
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

	// The run's duration ends here, not at shutdown.
	pi.on("agent_end", () => {
		state.endedAt = Date.now();
		ended = true;
	});

	pi.on("session_shutdown", async () => {
		if (reported) return;
		reported = true;
		if (!ended) state.endedAt = Date.now();
		const { API_URL, JOB_ID } = process.env;
		if (!API_URL || !JOB_ID) return void console.error("[results] API_URL or JOB_ID not set; result not reported");
		const ok = await postResult(`${API_URL}/jobs/${JOB_ID}/result`, buildPayload(state), { token: tokens?.token() });
		console.error(ok ? "[results] result reported" : "[results] could not report result");
	});
}
