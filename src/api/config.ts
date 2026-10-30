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
