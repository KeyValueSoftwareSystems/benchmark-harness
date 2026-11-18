import { access } from "node:fs/promises";
import path from "node:path";
import express from "express";
import type { generateReport, Narrator } from "./generate.ts";

export interface ReportsAppDeps {
	generate: typeof generateReport;
	reportsDir: string;
	resultsDir: string;
	narrate?: Narrator;
}

/** The report service over HTTP: build a report for chosen models, then read it back by id. */
export function createReportsApp({ generate, reportsDir, resultsDir, narrate }: ReportsAppDeps): express.Express {
	const app = express();
	app.use(express.json());

	app.post("/reports", async (req, res) => {
		const { benchmark, models } = req.body ?? {};
		if (typeof benchmark !== "string" || !benchmark || !Array.isArray(models) || !models.length || !models.every((m) => typeof m === "string" && m)) {
			return void res.status(400).json({ error: "benchmark and a non-empty list of models are required" });
		}
		try {
			const { id } = await generate({ benchmark, models, resultsDir, reportsDir, narrate });
			res.status(201).json({ id });
		} catch (err) {
			res.status(400).json({ error: err instanceof Error ? err.message : "could not build the report" });
		}
	});

	app.get("/reports/:id", async (req, res) => {
		const id = String(req.params.id);
		if (!/^[\w.-]+$/.test(id)) return void res.status(400).json({ error: "invalid report id" });
		const file = path.join(reportsDir, `${id}.html`);
		if (!(await access(file).then(() => true, () => false))) return void res.status(404).json({ error: "unknown report" });
		res.type("html").sendFile(file);
	});

	return app;
}
