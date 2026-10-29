import express from "express";
import type { ModelConfig } from "../shared/types.ts";
import { redact } from "../shared/types.ts";

const PORT = Number(process.env.PORT ?? 3000);
const MODELS: ModelConfig[] = JSON.parse(process.env.MODELS ?? "[]");

interface Replica {
	url: string;
	model: ModelConfig;
}
const registry = new Map<string, Replica[]>();

const app = express();
app.use(express.json());

app.post("/register", (req, res) => {
	const { benchmark, url } = req.body ?? {};
	if (typeof benchmark !== "string" || typeof url !== "string") {
		return void res.status(400).json({ error: "benchmark and url are required" });
	}
	const replicas = registry.get(benchmark) ?? [];
	registry.set(benchmark, replicas);
	let replica = replicas.find((r) => r.url === url);
	if (!replica) {
		const model = MODELS.find((m) => !replicas.some((r) => r.model.name === m.name));
		if (!model) return void res.status(409).json({ error: "all models already assigned" });
		replica = { url, model };
		replicas.push(replica);
	}
	res.json({ model: replica.model });
});

app.get("/benchmarks", (_req, res) => {
	res.json(
		Object.fromEntries(
			[...registry].map(([name, rs]) => [name, rs.map((r) => ({ url: r.url, model: redact(r.model) }))]),
		),
	);
});

app.get("/benchmarks/:benchmark/status", async (req, res) => {
	const replicas = registry.get(req.params.benchmark);
	if (!replicas) return void res.status(404).json({ error: "unknown benchmark" });
	res.json(
		await Promise.all(
			replicas.map(async (r) => {
				try {
					return { name: r.model.name, ...(await (await fetch(`${r.url}/state`)).json()) };
				} catch (err) {
					return { name: r.model.name, status: "unreachable", error: String(err) };
				}
			}),
		),
	);
});

// Dispatch the prompt to the selected replicas one after the other.
app.post("/benchmarks/:benchmark/run", async (req, res) => {
	const replicas = registry.get(req.params.benchmark);
	if (!replicas?.length) return void res.status(404).json({ error: "no replicas registered for benchmark" });
	const { prompt, models } = req.body ?? {};
	if (typeof prompt !== "string" || !prompt) return void res.status(400).json({ error: "prompt is required" });
	const selected = Array.isArray(models) ? replicas.filter((r) => models.includes(r.model.name)) : replicas;
	if (!selected.length) return void res.status(404).json({ error: "no matching models" });

	const results = [];
	for (const r of selected) {
		try {
			const resp = await fetch(`${r.url}/run`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ prompt }),
			});
			results.push({ model: r.model.name, replica: r.url, status: resp.status });
		} catch (err) {
			results.push({ model: r.model.name, replica: r.url, status: "unreachable", error: String(err) });
		}
	}
	res.status(202).json({ results });
});

app.listen(PORT, () => console.error(`[api] listening on ${PORT}, ${MODELS.length} model(s) configured`));
