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
import { MCP_PATH } from "../constants.ts";
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
		const endpoint = endpoints.get(req.params.name);
		if (!endpoint) {
			return { isError: true, content: [{ type: "text" as const, text: `unknown tool: ${req.params.name}` }] };
		}
		const res = await fetch(endpoint.url, {
			method: endpoint.method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(req.params.arguments ?? {}),
		});
		return { isError: !res.ok, content: [{ type: "text" as const, text: await res.text() }] };
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
