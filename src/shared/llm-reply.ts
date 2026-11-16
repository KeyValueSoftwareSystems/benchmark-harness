import { StringDecoder } from "node:string_decoder";

/** What a model replied with: its text and the tool calls it asked for. */
export interface LlmReply {
	text: string;
	toolCalls: { name: string; arguments: string }[];
	finishReason?: string;
	/** The start of the body as received, kept only when it is not a chat-completions or messages reply. */
	rawBody?: string;
}

const SSE_DATA_PREFIX = "data:";
const ANTHROPIC_STREAM_END = "message_stop";
const REPLY_SCAN_MAX_CHARS = 16 * 1024 * 1024;
const RAW_BODY_MAX_CHARS = 20_000;

/** Reply parts read so far; tool calls are keyed by the index the provider gives them within the reply. */
interface ReplyParts {
	text: string;
	toolCalls: Map<number, { name: string; arguments: string }>;
	finishReason?: string;
}

function toolCallAt(parts: ReplyParts, index: number): { name: string; arguments: string } {
	let call = parts.toolCalls.get(index);
	if (!call) {
		call = { name: "", arguments: "" };
		parts.toolCalls.set(index, call);
	}
	return call;
}

/** Reads one OpenAI chat-completions object: a stream chunk (`delta`) or a whole reply (`message`). */
function applyChatCompletions(parts: ReplyParts, choice: Record<string, any>): void {
	const part = choice.delta ?? choice.message ?? {};
	if (typeof part.content === "string") parts.text += part.content;
	(part.tool_calls ?? []).forEach((toolCall: Record<string, any>, position: number) => {
		const call = toolCallAt(parts, toolCall.index ?? position);
		call.name += toolCall.function?.name ?? "";
		call.arguments += toolCall.function?.arguments ?? "";
	});
	if (typeof choice.finish_reason === "string") parts.finishReason = choice.finish_reason;
}

/** Reads one Anthropic messages stream event. */
function applyMessagesEvent(parts: ReplyParts, event: Record<string, any>): void {
	if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
		toolCallAt(parts, event.index).name = event.content_block.name ?? "";
	} else if (event.type === "content_block_delta") {
		if (event.delta?.type === "text_delta") parts.text += event.delta.text ?? "";
		if (event.delta?.type === "input_json_delta") toolCallAt(parts, event.index).arguments += event.delta.partial_json ?? "";
	} else if (event.type === "message_delta" && typeof event.delta?.stop_reason === "string") {
		parts.finishReason = event.delta.stop_reason;
	}
}

/** Reads a whole Anthropic messages reply. */
function applyMessagesReply(parts: ReplyParts, reply: Record<string, any>): void {
	reply.content.forEach((block: Record<string, any>, position: number) => {
		if (block.type === "text") parts.text += block.text ?? "";
		if (block.type === "tool_use") {
			const call = toolCallAt(parts, position);
			call.name = block.name ?? "";
			call.arguments = JSON.stringify(block.input ?? {});
		}
	});
	if (typeof reply.stop_reason === "string") parts.finishReason = reply.stop_reason;
}

function applyReply(parts: ReplyParts, obj: unknown): void {
	if (!obj || typeof obj !== "object") return;
	const o = obj as Record<string, any>;
	if (Array.isArray(o.choices)) {
		for (const choice of o.choices) applyChatCompletions(parts, choice);
	} else if (Array.isArray(o.content)) {
		applyMessagesReply(parts, o);
	} else if (typeof o.type === "string") {
		applyMessagesEvent(parts, o);
	}
}

/** Collects the reply from a response body chunk by chunk, server-sent events or plain JSON. Never throws. */
export function createReplyCollector(contentType: string | null) {
	const sse = (contentType ?? "").includes("text/event-stream");
	const decoder = new StringDecoder("utf8");
	const parts: ReplyParts = { text: "", toolCalls: new Map() };
	let pending = "";
	let rawBody = "";
	let overflow = false;
	let streamEnded = false;

	const readEventLine = (line: string) => {
		if (!line.startsWith(SSE_DATA_PREFIX)) return;
		const data = line.slice(SSE_DATA_PREFIX.length).trim();
		if (data === "[DONE]") streamEnded = true;
		if (!data || data === "[DONE]") return;
		try {
			const event = JSON.parse(data);
			if (event?.type === ANTHROPIC_STREAM_END) streamEnded = true;
			applyReply(parts, event);
		} catch {
			// a data line that isn't JSON carries no reply
		}
	};

	return {
		/** True once a streamed reply has delivered its end marker, so nothing more is expected. */
		get streamEnded(): boolean {
			return streamEnded;
		},
		push(chunk: Buffer | string): void {
			const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
			if (rawBody.length < RAW_BODY_MAX_CHARS) rawBody += text.slice(0, RAW_BODY_MAX_CHARS - rawBody.length);
			if (overflow) return;
			pending += text;
			if (sse) {
				const lines = pending.split(/\r?\n/);
				pending = lines.pop() ?? "";
				for (const line of lines) readEventLine(line);
			} else if (pending.length > REPLY_SCAN_MAX_CHARS) {
				overflow = true;
				pending = "";
			}
		},
		finish(): LlmReply {
			pending += decoder.end();
			if (sse) readEventLine(pending);
			else if (!overflow && pending) {
				try {
					applyReply(parts, JSON.parse(pending));
				} catch {
					// not JSON: the raw body is kept below
				}
			}
			const toolCalls = [...parts.toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
			const reply: LlmReply = { text: parts.text, toolCalls, ...(parts.finishReason ? { finishReason: parts.finishReason } : {}) };
			const understood = reply.text !== "" || toolCalls.length > 0 || reply.finishReason !== undefined;
			return understood || rawBody === "" ? reply : { ...reply, rawBody };
		},
	};
}
