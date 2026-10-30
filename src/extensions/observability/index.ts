import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Netra, NetraInstruments, SpanType } from "netra-sdk";

type Span = ReturnType<typeof Netra.startSpan>;

const text = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c) => c?.type === "text")
		.map((c) => c.text)
		.join("");
};

const json = (value: unknown): string => {
	try {
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
};

export default function (pi: ExtensionAPI) {
	let enabled = false;
	let prompt = "";
	let root: Span | undefined;
	let turn: Span | undefined;
	let generation: Span | undefined;
	const tools = new Map<string, Span>();

	const child = (parent: Span | undefined, name: string, asType: SpanType, attributes?: Record<string, string>) => {
		const make = () => Netra.startSpan(name, { asType, attributes });
		return parent ? parent.withActive(make) : make();
	};

	const endAll = () => {
		for (const span of tools.values()) span.end();
		tools.clear();
		for (const span of [generation, turn, root]) span?.end();
		generation = turn = root = undefined;
	};

	// Handlers must never break a run: log to stderr and carry on.
	const safe =
		<A extends unknown[]>(fn: (...args: A) => void | Promise<void>) =>
		async (...args: A) => {
			if (!enabled) return;
			try {
				await fn(...args);
			} catch (err) {
				console.error(`[observability] ${err}`);
			}
		};

	pi.on("session_start", async (_event, ctx) => {
		if (!process.env.NETRA_OTLP_ENDPOINT || !process.env.NETRA_TENANT_ID) {
			console.error("[observability] NETRA_OTLP_ENDPOINT or NETRA_TENANT_ID not set; tracing disabled");
			return;
		}
		try {
			await Netra.init({
				// Spans are created manually from pi events; provider auto-instrumentation is not used.
				instruments: new Set(),
				blockInstruments: new Set([NetraInstruments.LANGGRAPH, NetraInstruments.LANGCHAIN]),
				traceContent: true,
				resourceAttributes: { "benchmark.model": ctx.model?.id ?? "unknown" },
			});
			Netra.setSessionId(randomUUID());
			Netra.setTenantId(process.env.NETRA_TENANT_ID);
			enabled = true;
			console.error(`[observability] tracing enabled (${process.env.NETRA_APP_NAME})`);
		} catch (err) {
			console.error(`[observability] init failed: ${err}`);
		}
	});

	pi.on(
		"agent_start",
		safe(() => {
			root = Netra.startSpan("agent_run", { asType: SpanType.AGENT });
			root.setAttribute("agent.input", prompt);
		}),
	);

	pi.on(
		"input",
		safe((event: { text?: string }) => {
			prompt = event.text ?? "";
		}),
	);

	pi.on(
		"turn_start",
		safe((event) => {
			turn = child(root, `turn-${event.turnIndex}`, SpanType.SPAN);
		}),
	);

	pi.on(
		"message_start",
		safe((event) => {
			if (event.message.role === "assistant") generation = child(turn ?? root, "generation", SpanType.GENERATION);
		}),
	);

	pi.on(
		"message_end",
		safe((event) => {
			const m = event.message;
			if (m.role !== "assistant" || !generation) return;
			generation.setModel(m.model).setLlmSystem(m.provider);
			generation.setAttribute("gen_ai.completion", text(m.content));
			generation.setUsage([
				{ model: m.model, usage_type: "input", units_used: m.usage.input },
				{ model: m.model, usage_type: "output", units_used: m.usage.output, cost_in_usd: m.usage.cost.total },
			]);
			if (m.stopReason === "error") generation.setError(m.errorMessage ?? "error");
			else generation.setSuccess();
			generation.end();
			generation = undefined;
		}),
	);

	pi.on(
		"tool_execution_start",
		safe((event) => {
			const span = child(turn ?? root, event.toolName, SpanType.TOOL, { "tool.call_id": event.toolCallId });
			span.setAttribute("tool.args", json(event.args));
			tools.set(event.toolCallId, span);
		}),
	);

	pi.on(
		"tool_execution_end",
		safe((event) => {
			const span = tools.get(event.toolCallId);
			if (!span) return;
			span.setAttribute("tool.result", json(event.result));
			if (event.isError) span.setError(json(event.result));
			else span.setSuccess();
			span.end();
			tools.delete(event.toolCallId);
		}),
	);

	pi.on(
		"turn_end",
		safe(() => {
			turn?.setSuccess().end();
			turn = undefined;
		}),
	);

	pi.on(
		"agent_end",
		safe((event) => {
			const last = [...event.messages].reverse().find((m) => m.role === "assistant");
			if (last) root?.setAttribute("agent.output", text(last.content));
			root?.setSuccess();
			endAll();
		}),
	);

	pi.events.on(
	  "benchmark_context",
		safe((event) => {
		
		}),
	);

	pi.events.on(
	  "benchmark_result",
		safe((event) => {
		  
		}),
	);

	pi.on("session_shutdown", async () => {
		if (!enabled) return;
		try {
			endAll();
			await Netra.shutdown();
		} catch (err) {
			console.error(`[observability] shutdown failed: ${err}`);
		}
	});
}
