import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Redis } from "ioredis";
import type { ResultPayload } from "../../shared/results.ts";
import type { Job, JobStatus } from "../../shared/types.ts";

const key = (id: string) => `job:${id}`;
/** Redis keys written outside this file. */
export const keys = {
	agentLlmToken: (jobId: string) => `agent-llm-token:${jobId}`,
	llmToken: (token: string) => `llm-token:${token}`,
};
const INDEX = "job-ids";

export async function createJob(redis: Redis, input: Pick<Job, "benchmark" | "prompt" | "model" | "params">): Promise<Job> {
	const job: Job = { id: randomUUID().slice(0, 8), ...input, status: "queued", createdAt: new Date().toISOString() };
	const { params, ...fields } = job;
	await redis.multi().hset(key(job.id), { ...fields, ...(params && { params: JSON.stringify(params) }) }).rpush(INDEX, job.id).exec();
	return job;
}

export async function getJob(redis: Redis, id: string): Promise<Job | undefined> {
	const data = await redis.hgetall(key(id));
	if (!data.id) return undefined;
	return { ...data, params: data.params ? JSON.parse(data.params) : undefined } as unknown as Job;
}

export async function listJobs(redis: Redis): Promise<Job[]> {
	const jobs = await Promise.all((await redis.lrange(INDEX, 0, -1)).map((id) => getJob(redis, id)));
	return jobs.filter((j): j is Job => !!j);
}

export async function setStatus(redis: Redis, id: string, status: JobStatus, error?: string) {
	await redis.hset(key(id), error === undefined ? { status } : { status, error });
}

export const requestCancel = (redis: Redis, id: string) => redis.hset(key(id), "cancelRequested", "1");
export const isCancelRequested = async (redis: Redis, id: string) => (await redis.hget(key(id), "cancelRequested")) === "1";

/** Context can be fetched once per run, so a process in the agent container can't just ask for it again. */
export const claimContext = async (redis: Redis, id: string) => (await redis.hsetnx(key(id), "contextServed", "1")) === 1;
/** A (re-)run starts clean: the context claim, any result a previous attempt reported, and its token. */
export const resetContextClaim = (redis: Redis, id: string) => redis.hdel(key(id), "contextServed", "result", "resultToken");

/** The agent's reported result for a job; the first report wins, a repeat returns false. */
export async function saveResult(redis: Redis, id: string, payload: ResultPayload): Promise<boolean> {
	return (await redis.hsetnx(key(id), "result", JSON.stringify(payload))) === 1;
}

export async function getResult(redis: Redis, id: string): Promise<ResultPayload | undefined> {
	const raw = await redis.hget(key(id), "result");
	return raw ? (JSON.parse(raw) as ResultPayload) : undefined;
}

/** One-time token the agent needs to report a result; undefined when already issued. */
export async function issueResultToken(redis: Redis, id: string): Promise<string | undefined> {
	const token = randomUUID();
	return (await redis.hsetnx(key(id), "resultToken", token)) === 1 ? token : undefined;
}

export async function verifyResultToken(redis: Redis, id: string, token: string): Promise<boolean> {
	const expected = await redis.hget(key(id), "resultToken");
	if (!expected) return false;
	const a = Buffer.from(token);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
