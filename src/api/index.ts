import os from "node:os";
import express from "express";
import { benchmarks } from "./benchmarks/index.ts";
import { concurrencyFor, MODELS, PORT } from "./config.ts";
import { sweep } from "./docker/cli.ts";
import { startWorker } from "./queue/worker.ts";
import { redis } from "./redis.ts";
import { runJob } from "./runner.ts";
import { agents } from "./routes/agents.ts";
import { jobs } from "./routes/jobs.ts";
import { llmRouter } from "./routes/llm.ts";

const app = express();
// Model requests carry tool definitions and history, far beyond the 100kb default; 32mb matches Anthropic's limit.
app.use("/llm", express.json({ limit: "32mb" }));
app.use(express.json());
// The jobs router guards every request it sees with MGMT_KEY, so agent-facing routers must come first.
app.use(agents, llmRouter(redis), jobs);

await sweep().catch((err) => console.error(`[api] startup sweep failed: ${err}`));
for (const b of benchmarks.values()) {
	void startWorker(redis, b.name, runJob, { concurrency: concurrencyFor(b.name, b.concurrency), consumer: os.hostname() });
}

const server = app.listen(PORT, () => console.error(`[api] listening on ${PORT}, ${MODELS.length} model(s) configured`));

// PID 1 ignores SIGTERM unless handled. Jobs interrupted here are re-run from the stream and swept on next start.
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		console.error(`[api] ${signal} received, shutting down`);
		server.closeAllConnections();
		process.exit(0);
	});
}
