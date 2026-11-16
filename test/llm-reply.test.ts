import assert from "node:assert/strict";
import test from "node:test";
import { createReplyCollector } from "../src/shared/llm-reply.ts";

const collect = (contentType: string, chunks: string[]) => {
	const collector = createReplyCollector(contentType);
	for (const chunk of chunks) collector.push(chunk);
	return collector.finish();
};

test("chat-completions stream: text, tool call arguments split across chunks, finish reason", () => {
	const stream = [
		`data: {"choices":[{"delta":{"content":"Hel"}}]}`,
		`data: {"choices":[{"delta":{"content":"lo","tool_calls":[{"index":0,"function":{"name":"gmail_list","arguments":"{\\"q\\":"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a\\"}"}}]},"finish_reason":"tool_calls"}]}`,
		"data: [DONE]",
		"",
	].join("\n\n");
	const reply = collect("text/event-stream", [stream.slice(0, 41), stream.slice(41)]);
	assert.deepEqual(reply, { text: "Hello", toolCalls: [{ name: "gmail_list", arguments: '{"q":"a"}' }], finishReason: "tool_calls" });
});

test("chat-completions whole reply", () => {
	const body = { choices: [{ message: { content: "ok", tool_calls: [{ function: { name: "f", arguments: "{}" } }] }, finish_reason: "stop" }] };
	assert.deepEqual(collect("application/json", [JSON.stringify(body)]), { text: "ok", toolCalls: [{ name: "f", arguments: "{}" }], finishReason: "stop" });
});

test("anthropic stream: text and a tool_use block", () => {
	const events = [
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"calendar_list"}}`,
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"d\\":1}"}}`,
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}`,
		"",
	].join("\n\n");
	assert.deepEqual(collect("text/event-stream", [events]), { text: "Hi", toolCalls: [{ name: "calendar_list", arguments: '{"d":1}' }], finishReason: "tool_use" });
});

test("anthropic whole reply", () => {
	const body = { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "t", input: { a: 1 } }], stop_reason: "tool_use" };
	assert.deepEqual(collect("application/json", [JSON.stringify(body)]), { text: "ok", toolCalls: [{ name: "t", arguments: '{"a":1}' }], finishReason: "tool_use" });
});

test("an error body is kept raw", () => {
	const reply = collect("application/json", ['{"error":"rate limited"}']);
	assert.equal(reply.text, "");
	assert.equal(reply.rawBody, '{"error":"rate limited"}');
});

test("a streamed reply reports its end marker, openai and anthropic", () => {
	const openai = createReplyCollector("text/event-stream");
	openai.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
	assert.equal(openai.streamEnded, false);
	openai.push("data: [DONE]\n\n");
	assert.equal(openai.streamEnded, true);

	const anthropic = createReplyCollector("text/event-stream");
	anthropic.push('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n');
	assert.equal(anthropic.streamEnded, false);
	anthropic.push('data: {"type":"message_stop"}\n\n');
	assert.equal(anthropic.streamEnded, true);
});
