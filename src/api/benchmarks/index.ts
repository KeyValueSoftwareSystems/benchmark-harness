import { cyber } from "./cyber.ts";
import { minimal } from "./minimal.ts";
import { pa } from "./pa.ts";
import type { Benchmark } from "./types.ts";

/** Benchmarks the API provisions per job; each needs an agent image `bench/<name>`. */
export const benchmarks = new Map<string, Benchmark>([minimal, cyber, pa].map((b) => [b.name, b]));
