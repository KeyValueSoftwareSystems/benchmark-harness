import type { ModelConfig } from "../shared/types.ts";

export const PORT = Number(process.env.PORT ?? 3000);
/** How agent containers reach this service. */
export const API_URL = `http://api:${PORT}`;
export const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";
export const MODELS: ModelConfig[] = JSON.parse(process.env.MODELS ?? "[]");
export const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 30 * 60_000);

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

/** The report service the page asks to build and serve reports. */
export const REPORTS_URL = process.env.REPORTS_URL ?? "http://reports-api:3001";

/** Optional: one model (same JSON shape as a `MODELS` item) that reads a docs page to propose parameters for a new model. */
export const DISCOVERY_MODEL: ModelConfig | undefined = process.env.DISCOVERY_MODEL ? JSON.parse(process.env.DISCOVERY_MODEL) : undefined;

/** Netra MCP (insights are skipped when no key is set). EU projects use https://api.eu.getnetra.ai/mcp. */
export const NETRA_MCP_ENDPOINT = process.env.NETRA_MCP_ENDPOINT ?? "https://api.getnetra.ai/mcp";
export const NETRA_API_KEY = process.env.NETRA_API_KEY ?? "";
