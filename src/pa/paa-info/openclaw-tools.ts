#!/usr/bin/env node
/**
 * Prints the tool names of OpenClaw's enabled plugins, one per line, from the JSON of `openclaw plugins list --json` on stdin.
 */

interface PluginEntry {
	enabled?: boolean;
	toolNames?: string[];
}

export function enabledToolNames(pluginListJson: string): string[] {
	const { plugins } = JSON.parse(pluginListJson) as { plugins: PluginEntry[] };
	const names = plugins.filter((plugin) => plugin.enabled === true).flatMap((plugin) => plugin.toolNames ?? []);
	return [...new Set(names)].sort();
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
	console.log(enabledToolNames(await readStdin()).join("\n"));
}
