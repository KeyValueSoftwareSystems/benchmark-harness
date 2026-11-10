import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Agent, fetch } from "undici";

// An assistant turn can take longer than fetch's default 5-minute header wait; the job timeout bounds it instead.
const noTimeout = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

interface PAAContext {
	benchmark: string;
	world_id: string;
	assistant_endpoint: string;
	conversation_id: string;
	max_exchanges: number;
	max_replies: number;
	execution_date: string;
	task_name: string;
	exchange_token: string;
}

interface Exchange {
	user_message: string;
	assistant_reply: string;
	timestamp: string;  
}

/** Copies one exchange to the API so it survives the container being killed; failures don't stop the conversation. */
async function saveExchange(token: string, exchange: Exchange): Promise<void> {
	const { API_URL, JOB_ID } = process.env;
	try {
		const res = await fetch(`${API_URL}/jobs/${JOB_ID}/exchanges`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify(exchange),
		});
		if (!res.ok) throw new Error(`status ${res.status}`);
	} catch (err) {
		console.error(`[pa] could not save exchange: ${err}`);
	}
}

export default function (pi: ExtensionAPI) {
	let context: PAAContext | undefined;
	let announced = false;
	let ended = false;
	let exchangeCount = 0;
	const transcript: Exchange[] = [];

	// Fetch the one-time context from the API (assistant endpoint, limits, metadata).
	pi.on("session_start", async () => {
		const { API_URL, JOB_ID } = process.env;
		try {
			const res = await fetch(`${API_URL}/jobs/${JOB_ID}/context`);
			if (!res.ok) throw new Error(`status ${res.status}`);
			context = (await res.json()) as PAAContext;
			console.error(`[pa] loaded context for world ${context.world_id}`);
		} catch (err) {
			console.error(`[pa] could not load context: ${err}`);
		}
	});

	// Emit benchmark_context on first turn (non-grading metadata only).
	pi.on("turn_start", () => {
		if (announced || !context) return;
		announced = true;
		pi.events.emit("benchmark_context", {
			benchmark: context.benchmark,
			world_id: context.world_id,
			conversation_id: context.conversation_id,
			execution_date: context.execution_date,
			task_name: context.task_name,
			max_exchanges: context.max_exchanges,
			max_replies: context.max_replies,
		});
	});

	// -----------------------------------------------------------------------
	// Tool: ask_paa — send a message to the personal assistant agent
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "ask_paa",
		label: "Ask your assistant",
		description:
			"Send a message to your personal assistant. The assistant will process your request " +
			"using the tools available to it and reply. Use this for all communication with your assistant.",
		parameters: Type.Object({
			message: Type.String({ description: "The message to send to your assistant" }),
		}),
		async execute(_toolCallId, params) {
			if (!context) throw new Error("context is not loaded");
			if (ended) return { content: [{ type: "text" as const, text: "Conversation has already ended." }], details: undefined };
			if (exchangeCount >= context.max_exchanges) {
				ended = true;
				pi.events.emit("benchmark_result", {
					ended_by: "exchange_limit",
					reason: `Reached maximum of ${context.max_exchanges} exchanges`,
					exchange_count: exchangeCount,
					transcript,
				});
				return {
					content: [{ type: "text" as const, text: `Exchange limit (${context.max_exchanges}) reached. The conversation is over.` }],
					details: undefined,
					terminate: true,
				};
			}

			exchangeCount++;
			console.error(`[pa] exchange ${exchangeCount}/${context.max_exchanges}: sending message to PAA`);

			try {
				const res = await fetch(context.assistant_endpoint, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						conversation_id: context.conversation_id,
						message: params.message,
					}),
					dispatcher: noTimeout,
				});
				if (!res.ok) {
					const errText = await res.text().catch(() => "");
					throw new Error(`PAA returned ${res.status}: ${errText}`);
				}
				const reply = (await res.json()) as { response: string };

				const exchange: Exchange = {
					user_message: params.message,
					assistant_reply: reply.response,
					timestamp: new Date().toISOString(),
				};
				transcript.push(exchange);
				await saveExchange(context.exchange_token, exchange);

				console.error(`[pa] exchange ${exchangeCount}: got reply (${reply.response.length} chars)`);
				return { content: [{ type: "text" as const, text: reply.response }], details: undefined };
			} catch (err) {
				console.error(`[pa] ask_paa failed: ${err}`);
				return {
					content: [{ type: "text" as const, text: `Error communicating with assistant: ${err}` }],
					details: undefined,
				};
			}
		},
	});

	// -----------------------------------------------------------------------
	// Tool: end_conversation — PI signals the interaction is complete
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: "end_conversation",
		label: "End conversation",
		description:
			"End the conversation with your assistant. Call this when you are satisfied with the " +
			"assistant's work, or when you determine the assistant cannot complete the task. " +
			"You must provide an outcome (satisfied, partially_satisfied, or unsatisfied) and a reason.",
		parameters: Type.Object({
			outcome: Type.Union([
				Type.Literal("satisfied"),
				Type.Literal("partially_satisfied"),
				Type.Literal("unsatisfied"),
			], { description: "How satisfied you are with the assistant's work" }),
			reason: Type.String({ description: "Why you are ending the conversation" }),
		}),
		async execute(_toolCallId, params) {
			if (!context) throw new Error("context is not loaded");
			ended = true;
			pi.events.emit("benchmark_result", {
				ended_by: "user",
				outcome: params.outcome,
				reason: params.reason,
				exchange_count: exchangeCount,
				transcript,
			});
			console.error(`[pa] conversation ended: ${params.outcome} — ${params.reason}`);
			return {
				content: [{ type: "text" as const, text: "Conversation ended. Thank you." }],
				details: undefined,
				terminate: true,
			};
		},
	});

	// If the agent run ends without an explicit end_conversation, still emit a result.
	pi.on("agent_end", () => {
		if (ended || !context) return;
		ended = true;
		pi.events.emit("benchmark_result", {
			ended_by: "agent_timeout",
			outcome: "unsatisfied",
			reason: "Agent run ended without calling end_conversation",
			exchange_count: exchangeCount,
			transcript,
		});
		console.error("[pa] run ended without end_conversation");
	});
}
