/** Values shared by the API and the PAA container. */
export const PAA_CHAT_PORT = 8090;
/** Where the world (agent-side files) is mounted in the pi agent and PAA containers. */
export const WORLD_DIR_IN_CONTAINER = "/pa/world";
export const PAA_HEALTH_PATH = "/healthz";
export const MCP_PATH = "/mcp";

/** Port of the mock services' control server (tool-call log). Never registered with the PAA as an MCP server. */
export const MOCK_CONTROL_PORT = 9099;
export const MOCK_CALLS_PATH = "/calls";
/** Tool-call arguments longer than this (as JSON) are stored truncated. */
export const TOOL_CALL_ARGS_MAX_CHARS = 2048;

/** One tool call the PAA made through a mock service's MCP endpoint. */
export interface ToolCallRecord {
	service: string;
	tool: string;
	/** The call's arguments, or a truncated JSON string of them when they exceed `TOOL_CALL_ARGS_MAX_CHARS`. */
	args: unknown;
	ok: boolean;
	/** ISO timestamp of the call. */
	at: string;
}

/** Where each assistant's entrypoint writes its `PaaInfo`; the API reads it before the container stops. */
export const PAA_INFO_PATH = "/tmp/paa-info.json";

/** What ran for one job: the assistant's version and the toolsets it had enabled. */
export interface PaaInfo {
	version: string;
	toolsets: string[];
}

/** The personal assistants a PA job can test. Each lives in `docker/paa/<name>/`. */
export const PaAssistant = { openclaw: "openclaw", hermes: "hermes" } as const;
export type PaAssistant = (typeof PaAssistant)[keyof typeof PaAssistant];
export const DEFAULT_PA_ASSISTANT: PaAssistant = PaAssistant.openclaw;

/** How the API runs an assistant's container. */
export interface PaaProfile {
	image: string;
	/** The only writable path in the container (the assistant's state), mounted as tmpfs and owned by `uid`. */
	scratchDir: string;
	/** The assistant's user in the image. */
	uid: number;
}

export const PAA_PROFILES: Record<PaAssistant, PaaProfile> = {
	[PaAssistant.openclaw]: { image: "bench/pa-paa-openclaw", scratchDir: "/home/node/.openclaw", uid: 1000 },
	[PaAssistant.hermes]: { image: "bench/pa-paa-hermes", scratchDir: "/opt/data", uid: 10000 },
};

export const isPaAssistant = (value: unknown): value is PaAssistant =>
	typeof value === "string" && Object.hasOwn(PAA_PROFILES, value);
