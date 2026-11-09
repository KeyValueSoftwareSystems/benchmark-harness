import os from "node:os";
import express from "express";
import { benchmarks } from "./benchmarks/index.ts";
import { concurrencyFor, DISCOVERY_MODEL, PORT, REPORTS_URL, RESULTS_DIR } from "./config.ts";
import { discoverParameters } from "./discovery/extract.ts";
import { fetchDocsText } from "./discovery/fetch.ts";
import { db } from "./db/instance.ts";
import { reconcileModelFiles } from "./db/reconcile.ts";
import { sweep } from "./docker/cli.ts";
import { registry } from "./models/registry.ts";
import { startWorker } from "./queue/worker.ts";
import { redis } from "./redis.ts";
import { runJob } from "./runner.ts";
import { getJob, listJobs, requestCancel, issueResultToken, saveResult, verifyResultToken } from "./queue/store.ts";
import { agents } from "./routes/agents.ts";
import { jobs } from "./routes/jobs.ts";
import { createModelsRouter } from "./routes/models.ts";
import { createReportsRouter } from "./routes/reports.ts";
import { createRunsRouter } from "./routes/runs.ts";
import { createResultsRouter } from "./routes/results.ts";

const discoveryModel = DISCOVERY_MODEL;
const app = express();
app.use(express.json());
app.use(agents, jobs);
app.use(createReportsRouter({ baseUrl: REPORTS_URL }));
app.use(createRunsRouter({ listJobs: () => listJobs(redis), requestCancel: (id) => requestCancel(redis, id) }));
app.use(createModelsRouter({ registry, db, benchmarks, discovery: !!discoveryModel, discover: discoveryModel && (async (url) => discoverParameters(await fetchDocsText(url), discoveryModel)) }));
app.use(createResultsRouter({ jobExists: async (id) => !!(await getJob(redis, id)), saveResult: (id, payload) => saveResult(redis, id, payload), issueToken: (id) => issueResultToken(redis, id), verifyToken: (id, token) => verifyResultToken(redis, id, token) }));

await reconcileModelFiles(db, RESULTS_DIR)
	.then((n) => n && console.log(`[api] reconciled ${n} run(s) into the model result files`))
	.catch((err) => console.error(`[api] could not reconcile result files: ${err}`));
await sweep().catch((err) => console.error(`[api] startup sweep failed: ${err}`));
for (const b of benchmarks.values()) {
	void startWorker(redis, b.name, runJob, { concurrency: concurrencyFor(b.name, b.concurrency), consumer: os.hostname() });
}

const server = app.listen(PORT, () => console.error(`[api] listening on ${PORT}, ${registry.list().length} model(s) configured`));

// PID 1 ignores SIGTERM unless handled. Jobs interrupted here are re-run from the stream and swept on next start.
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => {
		console.error(`[api] ${signal} received, shutting down`);
		server.closeAllConnections();
		process.exit(0);
	});
}
