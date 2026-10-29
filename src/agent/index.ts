import path from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	runRpcMode,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();
const extensionsDir = path.resolve(cwd, "extensions");

const runtime = await createAgentSessionRuntime(
	async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { additionalExtensionPaths: [extensionsDir] },
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	},
	{ cwd, agentDir, sessionManager: SessionManager.inMemory() },
);

// stdout is reserved for RPC records; log to stderr only.
console.error(`[agent] RPC mode, extensions from ${extensionsDir}`);
await runRpcMode(runtime);
