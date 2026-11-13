import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { MCP_PATH, MOCK_CALLS_PATH, TOOL_CALL_ARGS_MAX_CHARS, type ToolCallRecord } from "../src/pa/constants.ts";
import { controlRouter, mcpRouter } from "../src/pa/mock-services/mcp.ts";

// One mock service with a REST route per tool, plus the control server, as start.ts wires them.
const service = express();
service.use(express.json());
service.post("/gmail/messages", (_req, res) => void res.json({ messages: [] }));
service.post("/gmail/broken", (_req, res) => void res.status(500).json({ error: "boom" }));
const server = service.listen(0);
const port = (server.address() as AddressInfo).port;
service.use(
	mcpRouter(
		"gmail",
		[
			{ name: "gmail_list_messages", description: "list" },
			{ name: "gmail_broken", description: "fails" },
		],
		[
			{ tool_name: "gmail_list_messages", url: `http://127.0.0.1:${port}/gmail/messages`, method: "POST" },
			{ tool_name: "gmail_broken", url: `http://127.0.0.1:${port}/gmail/broken`, method: "POST" },
		],
	),
);
const control = express().use(controlRouter()).listen(0);
const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}${MOCK_CALLS_PATH}`;
test.after(() => {
	server.close();
	control.close();
});

async function callTool(name: string, args: Record<string, unknown>) {
	const client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${MCP_PATH}`)));
	try {
		return await client.callTool({ name, arguments: args });
	} finally {
		await client.close();
	}
}

const calls = async () => (await (await fetch(controlUrl)).json()) as ToolCallRecord[];

test("a call through /mcp appears in GET /calls with its service, tool, args and outcome", async () => {
	await callTool("gmail_list_messages", { days_back: 3 });
	await callTool("gmail_broken", {});
	const [ok, failed] = await calls();
	assert.deepEqual([ok.service, ok.tool, ok.args, ok.ok], ["gmail", "gmail_list_messages", { days_back: 3 }, true]);
	assert.ok(!Number.isNaN(Date.parse(ok.at)));
	assert.deepEqual([failed.tool, failed.ok], ["gmail_broken", false]);
});

test("long arguments are stored truncated", async () => {
	await callTool("gmail_list_messages", { query: "x".repeat(TOOL_CALL_ARGS_MAX_CHARS * 2) });
	const last = (await calls()).at(-1);
	assert.equal(typeof last?.args, "string");
	assert.ok((last?.args as string).length < TOOL_CALL_ARGS_MAX_CHARS + 20);
	assert.ok((last?.args as string).endsWith("[truncated]"));
});
