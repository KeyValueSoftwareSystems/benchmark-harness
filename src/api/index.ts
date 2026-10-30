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

const app = express();
app.use(express.json());
app.use(agents, jobs);

await sweep().catch((err) => console.error(`[api] startup sweep failed: ${err}`));
for (const b of benchmarks.values()) {
	void startWorker(redis, b.name, runJob, { concurrency: concurrencyFor(b.name, b.concurrency), consumer: os.hostname() });
}

app.listen(PORT, () => console.error(`[api] listening on ${PORT}, ${MODELS.length} model(s) configured`));
