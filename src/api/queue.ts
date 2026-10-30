import type { Redis } from "ioredis";

const STREAM = "jobs";
const GROUP = "workers";

export const enqueue = (redis: Redis, jobId: string) => redis.call("XADD", STREAM, "*", "jobId", jobId);

type Entry = [entryId: string, fields: string[]];

const toJobs = (entries: Entry[]) => entries.map(([entryId, fields]) => ({ entryId, jobId: fields[fields.indexOf("jobId") + 1] }));

/**
 * Consumes the job stream with a consumer group, running at most `concurrency` handlers at once.
 * Entries are acked only after the handler settles; entries left pending by a crashed instance are
 * re-claimed on startup and run again.
 */
export async function startWorker(
	redis: Redis,
	handle: (jobId: string) => Promise<void>,
	{ concurrency, consumer }: { concurrency: number; consumer: string },
) {
	try {
		await redis.call("XGROUP", "CREATE", STREAM, GROUP, "0", "MKSTREAM");
	} catch (err) {
		if (!String(err).includes("BUSYGROUP")) throw err;
	}
	const reader = redis.duplicate();

	let inflight = 0;
	let wake: (() => void) | undefined;
	const dispatch = ({ entryId, jobId }: { entryId: string; jobId: string }) => {
		inflight++;
		console.log(`[queue] job ${jobId} claimed (${inflight}/${concurrency} running)`);
		handle(jobId)
			.catch((err) => console.error(`[queue] job ${jobId} failed: ${err}`))
			.finally(async () => {
				await redis.call("XACK", STREAM, GROUP, entryId);
				await redis.call("XDEL", STREAM, entryId);
				inflight--;
				wake?.();
			});
	};

	// Take over entries a previous (dead) instance left pending.
	let cursor = "0-0";
	do {
		const [next, entries] = (await redis.call("XAUTOCLAIM", STREAM, GROUP, consumer, 0, cursor, "COUNT", 100)) as [string, Entry[]];
		if (entries.length) console.log(`[queue] re-claiming ${entries.length} pending job(s) from a previous run`);
		toJobs(entries).forEach(dispatch);
		cursor = next;
	} while (cursor !== "0-0");

	while (true) {
		if (inflight >= concurrency) {
			await new Promise<void>((resolve) => (wake = resolve));
			continue;
		}
		try {
			const res = (await reader.call(
				"XREADGROUP", "GROUP", GROUP, consumer, "COUNT", concurrency - inflight, "BLOCK", 5000, "STREAMS", STREAM, ">",
			)) as [stream: string, entries: Entry[]] | null;
			// Single stream, so ioredis returns [stream, entries] rather than a list of those pairs.
			if (res) toJobs(res[1]).forEach(dispatch);
		} catch (err) {
			console.error(`[queue] read failed: ${err}`);
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}
