import type { ModelConfig } from "../shared/types.ts";

export const PORT = Number(process.env.PORT ?? 3000);
/** How agent containers reach this service. */
export const API_URL = `http://api:${PORT}`;
export const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";
export const MODELS: ModelConfig[] = JSON.parse(process.env.MODELS ?? "[]");
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 30 * 60_000);
/** Required for the management routes; without it anyone who can reach the API could queue jobs. */
export const MGMT_KEY = process.env.MGMT_KEY ?? "";
if (!MGMT_KEY) throw new Error("MGMT_KEY is required (set it in .env)");
/** This container's name, used to connect it to per-job networks; set in docker-compose.yml alongside container_name. */
export const API_CONTAINER_NAME = process.env.API_CONTAINER_NAME ?? "";
if (!API_CONTAINER_NAME) throw new Error("API_CONTAINER_NAME is required (set in docker-compose.yml)");

/** Max jobs of one benchmark running at once: `CONCURRENCY_<NAME>` overrides the benchmark's default. */
export const concurrencyFor = (benchmark: string, fallback: number) =>
	Number(process.env[`CONCURRENCY_${benchmark.toUpperCase()}`] ?? fallback);

/** Challenge definitions. Must be mounted at the same path on the host: compose runs against the host daemon. */
export const RESOURCES_DIR = process.env.RESOURCES_DIR ?? "/app/resources";

/** SQLite file and per-model JSON results; both live on the shared `harness-data` volume. */
export const DB_PATH = process.env.DB_PATH ?? "/data/harness.db";
export const RESULTS_DIR = process.env.RESULTS_DIR ?? "/data/results";
/** Run conditions recorded with every result (shown on reports). */
export const CONDITIONS = { maxTurns: Number(process.env.MAX_TURNS) || null, jobTimeoutMs: JOB_TIMEOUT_MS };

/** Netra MCP (insights are skipped when no key is set). EU projects use https://api.eu.getnetra.ai/mcp. */
export const NETRA_MCP_ENDPOINT = process.env.NETRA_MCP_ENDPOINT ?? "https://api.getnetra.ai/mcp";
export const NETRA_API_KEY = process.env.NETRA_API_KEY ?? "";
