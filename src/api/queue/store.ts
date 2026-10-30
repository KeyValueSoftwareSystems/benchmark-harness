import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Job, JobStatus } from "../../shared/types.ts";

const key = (id: string) => `job:${id}`;
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
export const resetContextClaim = (redis: Redis, id: string) => redis.hdel(key(id), "contextServed");
