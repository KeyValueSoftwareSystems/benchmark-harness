import os from "node:os";
import express from "express";
import { benchmarks } from "./benchmarks/index.ts";
import { concurrencyFor, MODELS, PORT, RESULTS_DIR } from "./config.ts";
import { db } from "./db/instance.ts";
import { reconcileModelFiles } from "./db/reconcile.ts";
import { sweep } from "./docker/cli.ts";
import { startWorker } from "./queue/worker.ts";
import { redis } from "./redis.ts";
import { runJob } from "./runner.ts";
import { getJob, issueResultToken, saveResult, verifyResultToken } from "./queue/store.ts";
import { agents } from "./routes/agents.ts";
import { jobs } from "./routes/jobs.ts";
import { llmRouter } from "./routes/llm.ts";
import { createResultsRouter } from "./routes/results.ts";

const app = express();
// Model requests carry tool definitions and history, far beyond the 100kb default; 32mb matches Anthropic's limit.
app.use("/llm", express.json({ limit: "32mb" }));
app.use(express.json());
// The jobs router guards every request it sees with MGMT_KEY, so agent-facing routers must come first.
app.use(agents, llmRouter(redis), jobs);
app.use(createResultsRouter({ jobExists: async (id) => !!(await getJob(redis, id)), saveResult: (id, payload) => saveResult(redis, id, payload), issueToken: (id) => issueResultToken(redis, id), verifyToken: (id, token) => verifyResultToken(redis, id, token) }));

await reconcileModelFiles(db, RESULTS_DIR)
	.then((n) => n && console.log(`[api] reconciled ${n} run(s) into the model result files`))
	.catch((err) => console.error(`[api] could not reconcile result files: ${err}`));
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
