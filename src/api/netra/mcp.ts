import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { NetraClient } from "./enrich.ts";

/** Pulls the trace ids out of a `netra_get_session_details` response; tolerant of the exact field names. */
export function traceIdsOf(data: unknown): string[] {
	const traces = (data as { traces?: unknown } | null)?.traces;
	if (!Array.isArray(traces)) return [];
	return traces
		.map((t) => (t as { trace_id?: unknown; traceId?: unknown; id?: unknown })?.trace_id ?? (t as { traceId?: unknown }).traceId ?? (t as { id?: unknown }).id)
		.filter((id): id is string => typeof id === "string");
}

/** Netra's remote MCP server (streamable HTTP, project API key in `x-api-key`). One short-lived connection per call. */
export function createNetraClient(endpoint: string, apiKey: string): NetraClient {
	return {
		async sessionDetails(sessionId) {
			const client = new Client({ name: "benchmark-harness", version: "1.0.0" });
			const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { "x-api-key": apiKey } } });
			try {
				await client.connect(transport);
				const result = await client.callTool({ name: "netra_get_session_details", arguments: { session_id: sessionId } });
				if (result.isError) throw new Error("netra_get_session_details returned an error");
				const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text;
				if (!text) return undefined;
				const data = JSON.parse(text) as unknown;
				const traceIds = traceIdsOf(data);
				return traceIds.length ? { traceIds, data } : undefined;
			} finally {
				await client.close().catch(() => undefined);
			}
		},
	};
}
