import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// GAIA-style quasi-exact match: numbers compare numerically, lists elementwise, strings case/space-insensitively.
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.]$/, "");
const num = (s: string) => (/^[\d.,$%\s-]+$/.test(s) ? Number(s.replace(/[$%,\s]/g, "")) : NaN);
function matches(given: string, expected: string): boolean {
	const g = given.split(/[,;]/).map(norm);
	const e = expected.split(/[,;]/).map(norm);
	if (g.length !== e.length) return norm(given) === norm(expected);
	return e.every((x, i) => (Number.isNaN(num(x)) ? x === g[i] : num(x) === num(g[i])));
}

interface TaskContext {
	answer?: string;
	[key: string]: unknown;
}

export default function (pi: ExtensionAPI) {
	pi.registerMcpServer("obscura", {
		command: "obscura",
		args: ["mcp"],
		exposure: "direct",
		description: "Headless browser: navigate, click, fill forms, extract page content",
	});

	let context: TaskContext | undefined;
	let announced = false;
	let submitted = false;

	// Plain-prompt runs have no task, so no context and no scoring.
	pi.on("session_start", async () => {
		const { API_URL, JOB_ID } = process.env;
		try {
			const res = await fetch(`${API_URL}/jobs/${JOB_ID}/context`);
			if (!res.ok) throw new Error(`status ${res.status}`);
			const body = (await res.json()) as TaskContext;
			if (body.answer !== undefined) context = body;
		} catch (err) {
			console.error(`[browser] could not load task context: ${err}`);
		}
	});

	pi.on("turn_start", () => {
		if (announced || !context) return;
		announced = true;
		pi.events.emit("benchmark_context", context);
	});

	pi.registerTool({
		name: "submit_answer",
		label: "Submit answer",
		description: "Submit your final answer to the task. You get exactly one submission and it ends the task.",
		parameters: Type.Object({ answer: Type.String({ description: "The final answer only" }) }),
		async execute(_toolCallId, params) {
			submitted = true;
			if (context?.answer === undefined) return { content: [{ type: "text", text: "Answer recorded." }], details: undefined, terminate: true };
			const correct = matches(params.answer, context.answer);
			pi.events.emit("benchmark_result", { submitted: true, answer: params.answer, expected: context.answer, correct });
			console.error(`[browser] answer submitted, correct=${correct}`);
			return { content: [{ type: "text", text: "Answer submitted. The task is over." }], details: undefined, terminate: true };
		},
	});

	pi.on("agent_end", () => {
		if (submitted || !context) return;
		submitted = true;
		pi.events.emit("benchmark_result", { submitted: false, answer: "", expected: context.answer, correct: false });
	});
}
