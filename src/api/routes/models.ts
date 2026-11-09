import type { DatabaseSync } from "node:sqlite";
import { Router } from "express";
import type { Benchmark } from "../benchmarks/types.ts";
import { DiscoveryError } from "../discovery/fetch.ts";
import { listRuns } from "../db/runs.ts";
import { insecureKeyGuard } from "../models/guard.ts";
import type { Registry } from "../models/registry.ts";
import { redact } from "../../shared/types.ts";
import type { ModelConfig } from "../../shared/types.ts";

export interface ModelsRouterDeps {
	registry: Registry;
	db: DatabaseSync;
	benchmarks: Map<string, Benchmark>;
	/** Whether a discovery model is configured (the page hides "Discover parameters" without one). */
	discovery: boolean;
	/** How many items the page may hold in its queue. */
	queueLimit: number;
	/** Reads a docs link and proposes parameters; absent when no discovery model is configured. */
	discover?: (docsUrl: string) => Promise<unknown>;
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** Models the UI can show and add, and the benchmarks it can start. API keys never appear in a response. */
export function createModelsRouter({ registry, db, benchmarks, discovery, discover, queueLimit }: ModelsRouterDeps): Router {
	const router = Router();
	const keyGuard = insecureKeyGuard();

	router.get("/models", (_req, res) => {
		const benchmarked = new Map<string, Set<string>>();
		for (const r of listRuns(db, {})) benchmarked.set(r.model, (benchmarked.get(r.model) ?? new Set()).add(r.benchmark));
		const known = registry.list().map((m) => ({
			...redact(m),
			session: registry.isSession(m.name),
			needsKey: registry.needsKey(m.name),
			benchmarked: [...(benchmarked.get(m.name) ?? [])],
		}));
		// Stored results survive an API restart, session models do not: show those models read-only.
		const readOnly = [...benchmarked]
			.filter(([name]) => !registry.find(name))
			.map(([name, set]) => ({ name, modelId: name, baseUrl: "", api: "", session: false, needsKey: true, readOnly: true, benchmarked: [...set] }));
		res.json({ discovery, queueLimit, models: [...known, ...readOnly] });
	});

	router.post("/models", keyGuard, (req, res) => {
		const b = req.body ?? {};
		if (!isStr(b.name) || !isStr(b.baseUrl) || !/^https?:\/\//.test(b.baseUrl) || !isStr(b.api)) {
			return void res.status(400).json({ error: "name, baseUrl (http or https) and api are required" });
		}
		if (b.apiKey !== undefined && typeof b.apiKey !== "string") return void res.status(400).json({ error: "apiKey must be a string" });
		if (b.thinkingLevel !== undefined && !THINKING.has(b.thinkingLevel)) return void res.status(400).json({ error: "unknown thinkingLevel" });
		const model: ModelConfig = {
			name: b.name,
			modelId: isStr(b.modelId) ? b.modelId : b.name,
			baseUrl: b.baseUrl,
			api: b.api,
			apiKey: b.apiKey ?? "",
			thinkingLevel: b.thinkingLevel,
			cost: b.cost && Number.isFinite(b.cost.input) && Number.isFinite(b.cost.output) ? { input: b.cost.input, output: b.cost.output } : undefined,
		};
		if (registry.add(model) === "clash") return void res.status(409).json({ error: "a model with that name already exists" });
		res.status(201).json({ ...redact(model), session: true, needsKey: model.apiKey === "", benchmarked: [] });
	});

	router.delete("/models/:name", (req, res) => void res.status(registry.remove(String(req.params.name)) ? 204 : 404).end());

	router.put("/models/:name/key", keyGuard, (req, res) => {
		const apiKey = req.body?.apiKey;
		if (typeof apiKey !== "string") return void res.status(400).json({ error: "apiKey is required" });
		res.status(registry.setKey(String(req.params.name), apiKey) ? 204 : 404).end();
	});

	router.post("/models/discover", async (req, res) => {
		if (!discover) return void res.status(404).json({ error: "parameter discovery is not configured" });
		const docsUrl = req.body?.docsUrl;
		if (!isStr(docsUrl)) return void res.status(400).json({ error: "docsUrl is required" });
		try {
			res.json(await discover(docsUrl));
		} catch (err) {
			if (err instanceof DiscoveryError) return void res.status(400).json({ error: err.message });
			console.error(`[api] discovery failed: ${err instanceof Error ? err.name : "error"}`);
			res.status(502).json({ error: "could not read the docs page" });
		}
	});

	router.get("/benchmarks", async (_req, res) => {
		const out = await Promise.all(
			[...benchmarks.values()].map(async (b) => ({ name: b.name, challenges: (await b.challenges?.()) ?? [], needsPrompt: !b.challenges })),
		);
		res.json(out);
	});

	return router;
}
