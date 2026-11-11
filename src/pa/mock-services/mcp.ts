/**
 * MCP endpoint for one mock service, so any MCP-capable PAA harness can use
 * the world's tools without harness-specific plugins.
 *
 * Tool names, descriptions and input schemas come from world.yaml. Each tool
 * call is forwarded to the tool's REST route (`tool_endpoints`), so the REST
 * handlers stay the single source of behaviour.
 *
 * Stateless Streamable HTTP: every POST /mcp gets a fresh server and transport.
 */

import { Router } from "express";
import { MCP_PATH, MOCK_CALLS_PATH, TOOL_CALL_ARGS_MAX_CHARS, type ToolCallRecord } from "../constants.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface ToolDef {
	name: string;
	description: string;
	input_schema?: { type: "object"; [key: string]: unknown };
}

export interface ToolEndpoint {
	tool_name: string;
	url: string;
	method: string;
}

/** Every tool call made through any service's `/mcp` in this process, in order; served by the control server. */
export const toolCalls: ToolCallRecord[] = [];

function capArgs(args: unknown): unknown {
	const text = JSON.stringify(args ?? {});
	return text.length > TOOL_CALL_ARGS_MAX_CHARS ? `${text.slice(0, TOOL_CALL_ARGS_MAX_CHARS)}…[truncated]` : (args ?? {});
}

export function recordToolCall(service: string, tool: string, args: unknown, ok: boolean): void {
	toolCalls.push({ service, tool, args: capArgs(args), ok, at: new Date().toISOString() });
}

function createServer(service: string, tools: ToolDef[], endpoints: Map<string, ToolEndpoint>): Server {
	const server = new Server({ name: `pa-${service}`, version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.input_schema ?? { type: "object" as const, properties: {} },
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const { name, arguments: args } = req.params;
		const endpoint = endpoints.get(name);
		if (!endpoint) {
			recordToolCall(service, name, args, false);
			return { isError: true, content: [{ type: "text" as const, text: `unknown tool: ${name}` }] };
		}
		try {
			const res = await fetch(endpoint.url, {
				method: endpoint.method,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(args ?? {}),
			});
			recordToolCall(service, name, args, res.ok);
			return { isError: !res.ok, content: [{ type: "text" as const, text: await res.text() }] };
		} catch (err) {
			recordToolCall(service, name, args, false);
			throw err;
		}
	});

	return server;
}

/** Router serving `/mcp` with the given tools; `endpoints` must hold a route for each tool. */
export function mcpRouter(service: string, tools: ToolDef[], endpoints: ToolEndpoint[]): Router {
	const byName = new Map(endpoints.map((e) => [e.tool_name, e]));
	const router = Router();

	router.post(MCP_PATH, async (req, res) => {
		const server = createServer(service, tools, byName);
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
		res.on("close", () => {
			void transport.close();
			void server.close();
		});
		try {
			await server.connect(transport);
			await transport.handleRequest(req, res, req.body);
		} catch (err) {
			console.error(`[mcp] ${service}: ${err}`);
			if (!res.headersSent) {
				res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
			}
		}
	});

	// Stateless: no server-initiated stream (GET) and no sessions to end (DELETE).
	router.all(MCP_PATH, (_req, res) => void res.status(405).set("Allow", "POST").end());

	return router;
}

/** Control routes for the API (the tool-call log); served on their own port, never as an MCP server. */
export function controlRouter(): Router {
	const router = Router();
	router.get(MOCK_CALLS_PATH, (_req, res) => void res.json(toolCalls));
	return router;
}
