#!/usr/bin/env node
/**
 * Prints a `PaaInfo` as JSON for an assistant's entrypoint to save at `PAA_INFO_PATH`.
 * Usage: index.ts <version> [toolset ...]
 */

import type { PaaInfo } from "../constants.ts";

export function buildPaaInfo(version: string, toolsets: string[]): PaaInfo {
	return { version, toolsets };
}

if (import.meta.main) {
	const [version, ...toolsets] = process.argv.slice(2);
	if (!version) throw new Error("usage: index.ts <version> [toolset ...]");
	console.log(JSON.stringify(buildPaaInfo(version, toolsets)));
}
