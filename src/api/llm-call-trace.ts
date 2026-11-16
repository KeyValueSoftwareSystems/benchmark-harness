/**
 * Per-job trace of model calls: one JSON line per call in `<dir>/<jobId>.jsonl`, appended as each call finishes.
 * A line holds the call's usage and cost, a running cost for the job, and the request and reply.
 * After the first call of a role, a request holds only the messages added since that role's previous call.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { LlmReply } from "../shared/llm-reply.ts";
import type { LlmCallRecord } from "./routes/llm.ts";

/** A model call's request as stored in the trace. */
export type TracedRequest = { messages: unknown[]; continuesPreviousCall: true } | { body: Record<string, unknown>; continuesPreviousCall: false };

/** One line of a job's trace file. */
export interface LlmCallTraceLine extends LlmCallRecord {
	call: number;
	/** The job's cost so far, including this call. */
	runningCostUsd: number;
	request: TracedRequest | null;
	reply: LlmReply;
	/** Why the call failed before a reply arrived. */
	error?: string;
}

/** How much of a role's message history the previous traced call covered. */
interface MessageHistory {
	count: number;
	hashOfAll: string;
}

const hashOf = (messages: unknown[]): string => createHash("sha256").update(JSON.stringify(messages)).digest("hex");

/** The messages of a request body: chat-completions and Anthropic `messages`, OpenAI Responses `input`. */
function messagesOf(body: Record<string, unknown>): unknown[] | undefined {
	const messages = body.messages ?? body.input;
	return Array.isArray(messages) ? messages : undefined;
}

export function createLlmCallTrace(dir: string) {
	const historyByJobRole = new Map<string, MessageHistory>();
	const costByJob = new Map<string, number>();

	function requestForTrace(jobId: string, role: string, body: Record<string, unknown> | undefined): TracedRequest | null {
		if (!body) return null;
		const messages = messagesOf(body);
		if (!messages) return { body, continuesPreviousCall: false };
		const key = `${jobId}:${role}`;
		const previous = historyByJobRole.get(key);
		historyByJobRole.set(key, { count: messages.length, hashOfAll: hashOf(messages) });
		const continues = previous !== undefined && messages.length >= previous.count && hashOf(messages.slice(0, previous.count)) === previous.hashOfAll;
		return continues ? { messages: messages.slice(previous.count), continuesPreviousCall: true } : { body, continuesPreviousCall: false };
	}

	return {
		/** Appends one call to the job's trace. */
		async append(jobId: string, call: number, record: LlmCallRecord, requestBody: Record<string, unknown> | undefined, reply: LlmReply, error?: string): Promise<void> {
			const runningCostUsd = (costByJob.get(jobId) ?? 0) + record.costUsd;
			costByJob.set(jobId, runningCostUsd);
			const line: LlmCallTraceLine = {
				call,
				...record,
				runningCostUsd,
				request: requestForTrace(jobId, record.role, requestBody),
				reply,
				...(error ? { error } : {}),
			};
			await mkdir(dir, { recursive: true });
			await appendFile(path.join(dir, `${jobId}.jsonl`), `${JSON.stringify(line)}\n`);
		},
	};
}

export type LlmCallTrace = ReturnType<typeof createLlmCallTrace>;
