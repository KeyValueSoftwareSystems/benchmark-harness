import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelConfig } from "../shared/types.ts";

export const PROVIDER = "bench";

/** Writes a models.json defining the benchmark provider and returns its directory (used as agentDir). */
export async function writeModelsJson(model: ModelConfig): Promise<string> {
	const agentDir = await mkdtemp(path.join(tmpdir(), "pi-agent-"));
	const models = {
		providers: {
			[PROVIDER]: {
				baseUrl: model.baseUrl,
				api: model.api,
				apiKey: model.apiKey,
				models: [{ id: model.modelId }],
			},
		},
	};
	await writeFile(path.join(agentDir, "models.json"), JSON.stringify(models), { mode: 0o600 });
	return agentDir;
}

/** Builds an in-memory pi session bound to `model`, loading extensions from ./extensions. */
export async function createSession(model: ModelConfig) {
	const cwd = process.cwd();
	const agentDir = await writeModelsJson(model);
	// Each subdirectory of ./extensions is one extension (it carries its own index.ts).
	const extensionsDir = path.resolve(cwd, "extensions");
	const extensionPaths = (await readdir(extensionsDir, { withFileTypes: true }))
		.filter((e) => e.isDirectory())
		.map((e) => path.join(extensionsDir, e.name));

	const runtime = await createAgentSessionRuntime(
		async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: { additionalExtensionPaths: extensionPaths },
			});
			const resolved = services.modelRuntime.getModel(PROVIDER, model.modelId);
			if (!resolved) throw new Error(`model ${PROVIDER}/${model.modelId} not found after writing models.json`);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: resolved,
					thinkingLevel: model.thinkingLevel,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		},
		{ cwd, agentDir, sessionManager: SessionManager.inMemory() },
	);
	return runtime;
}
