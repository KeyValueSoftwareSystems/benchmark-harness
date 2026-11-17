import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Agent, fetch } from "undici";

// An assistant turn can take longer than fetch's default 5-minute header wait; the job timeout bounds it instead.
const noTimeout = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/** How many times in a row the simulated user is reminded to use a tool after it answered in plain text. */
const MAX_TOOL_CALL_REMINDERS = 2;
const TOOL_CALL_REMINDER =
	"Plain text is not delivered to your assistant. Send what you want to say with the ask_paa tool, or call end_conversation if everything your goal asks for is done.";

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
	/** Actions the user may approve with `approve_action`; empty when the world has none. */
	approvable_actions: ApprovableAction[];
}

interface ApprovableAction {
	action: string;
	label: string;
}

interface Exchange {
	user_message: string;
	assistant_reply: string;
	timestamp: string;
	sent_at: string;
	/** Set only on approval exchanges. */
	approvals?: string[];
}

const APPROVE_ACTION_TOOL = "approve_action";

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
	let remindersSinceLastTool = 0;
	const transcript: Exchange[] = [];

	// Fetch the one-time context from the API (assistant endpoint, limits, metadata).
	pi.on("session_start", async () => {
		const { API_URL, JOB_ID } = process.env;
		try {
			const res = await fetch(`${API_URL}/jobs/${JOB_ID}/context`);
			if (!res.ok) throw new Error(`status ${res.status}`);
			context = (await res.json()) as PAAContext;
			console.error(`[pa] loaded context for world ${context.world_id}`);
			// Only worlds with something to approve give the user the approval tool.
			if (!context.approvable_actions.length) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== APPROVE_ACTION_TOOL));
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

	type ToolResult = { content: { type: "text"; text: string }[]; details: undefined; terminate?: boolean };
	const textResult = (text: string): ToolResult => ({ content: [{ type: "text" as const, text }], details: undefined });

	/** Sends one message to the assistant and records the exchange; shared by `ask_paa` and `approve_action`. */
	async function sendToAssistant(message: string, approvals?: string[]): Promise<ToolResult> {
		if (!context) throw new Error("context is not loaded");
		remindersSinceLastTool = 0;
		if (ended) return textResult("Conversation has already ended.");
		if (exchangeCount >= context.max_exchanges) {
			ended = true;
			pi.events.emit("benchmark_result", {
				ended_by: "exchange_limit",
				reason: `Reached maximum of ${context.max_exchanges} exchanges`,
				exchange_count: exchangeCount,
				transcript,
			});
			return { ...textResult(`Exchange limit (${context.max_exchanges}) reached. The conversation is over.`), terminate: true };
		}

		exchangeCount++;
		console.error(`[pa] exchange ${exchangeCount}/${context.max_exchanges}: sending message to PAA`);
		const sentAt = new Date().toISOString();

		try {
			const res = await fetch(context.assistant_endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					conversation_id: context.conversation_id,
					message,
				}),
				dispatcher: noTimeout,
			});
			if (!res.ok) {
				const errText = await res.text().catch(() => "");
				throw new Error(`PAA returned ${res.status}: ${errText}`);
			}
			const reply = (await res.json()) as { response: string };

			const exchange: Exchange = {
				user_message: message,
				assistant_reply: reply.response,
				timestamp: new Date().toISOString(),
				sent_at: sentAt,
				...(approvals && { approvals }),
			};
			transcript.push(exchange);
			await saveExchange(context.exchange_token, exchange);

			console.error(`[pa] exchange ${exchangeCount}: got reply (${reply.response.length} chars)`);
			return textResult(reply.response);
		} catch (err) {
			console.error(`[pa] exchange failed: ${err}`);
			return textResult(`Error communicating with assistant: ${err}`);
		}
	}

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
			return sendToAssistant(params.message);
		},
	});

	// -----------------------------------------------------------------------
	// Tool: approve_action — the user lets the assistant go ahead with an action it has shown
	// -----------------------------------------------------------------------
	pi.registerTool({
		name: APPROVE_ACTION_TOOL,
		label: "Approve an action",
		description:
			"Approve an action your assistant has shown you and asked to go ahead with. Use it only after you have seen " +
			"exactly what the assistant is about to do and it matches your goal. To ask for changes first, use ask_paa.",
		parameters: Type.Object({
			action: Type.String({ description: "The action you approve; one of the actions listed in your instructions" }),
			note: Type.Optional(Type.String({ description: "Anything to add to your approval" })),
		}),
		async execute(_toolCallId, params) {
			if (!context) throw new Error("context is not loaded");
			const approved = context.approvable_actions.find((candidate) => candidate.action === params.action);
			if (!approved) {
				const allowed = context.approvable_actions.map((candidate) => candidate.action).join(", ") || "none";
				return textResult(`Cannot approve "${params.action}". Actions you can approve: ${allowed}.`);
			}
			const note = params.note?.trim();
			return sendToAssistant(`I approve: ${approved.label}. Go ahead.${note ? ` ${note}` : ""}`, [approved.action]);
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

	// The simulated user's turn can end with plain text instead of a tool call. Remind it to use a tool; if it keeps
	// answering in plain text, end the conversation with a result.
	pi.on("agent_end", () => {
		if (ended || !context) return;
		if (remindersSinceLastTool < MAX_TOOL_CALL_REMINDERS) {
			remindersSinceLastTool++;
			console.error(`[pa] simulated user answered without a tool call; reminder ${remindersSinceLastTool}`);
			pi.sendUserMessage(TOOL_CALL_REMINDER, { deliverAs: "followUp" });
			return;
		}
		ended = true;
		pi.events.emit("benchmark_result", {
			ended_by: "persona_stopped_without_tool_call",
			outcome: "unsatisfied",
			reason: "The simulated user stopped without calling end_conversation",
			exchange_count: exchangeCount,
			transcript,
		});
		console.error("[pa] run ended without end_conversation");
	});
}
