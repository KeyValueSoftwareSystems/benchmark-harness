// Type-only import: in the agent image extensions live at /app/extensions/<name>, so runtime imports of src/shared would not resolve.
import type { ResultPayload } from "../../shared/results.ts";

export interface CollectedState {
	usages: { input: number; output: number; cost: number }[];
	turns: number;
	startedAt: number;
	endedAt: number;
	/** The last `benchmark_result` event, or null when the benchmark emitted none. */
	outcome: Record<string, unknown> | null;
	sessionId?: string;
}

export function buildPayload(state: CollectedState): ResultPayload {
	const sum = (pick: (u: CollectedState["usages"][number]) => number) => state.usages.reduce((total, u) => total + pick(u), 0);
	return {
		outcome: state.outcome,
		metrics: {
			turns: state.turns,
			durationMs: Math.max(0, state.endedAt - state.startedAt),
			inputTokens: sum((u) => u.input),
			outputTokens: sum((u) => u.output),
			// Round away float noise from summing many small costs.
			costUsd: Math.round(sum((u) => u.cost) * 1e8) / 1e8,
		},
		...(state.sessionId ? { sessionId: state.sessionId } : {}),
	};
}

export interface PostOptions {
	fetchFn?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
	attempts?: number;
	/** The job's one-time result token; the api refuses results without it. */
	token?: string;
}

/**
 * Fetches the job's result token (served once, so the model can't claim it later). A refusal (403/404) is final;
 * other failures are retried. Never throws.
 */
export async function fetchResultToken(url: string, opts: PostOptions = {}): Promise<string | undefined> {
	const { fetchFn = fetch, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)), attempts = 5 } = opts;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetchFn(url);
			if (res.ok) return ((await res.json()) as { token?: string }).token;
			if (res.status === 403 || res.status === 404) return undefined;
			console.error(`[results] token request returned ${res.status} (attempt ${attempt}/${attempts})`);
		} catch (err) {
			console.error(`[results] token request failed (attempt ${attempt}/${attempts}): ${err}`);
		}
		if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
	}
	return undefined;
}

/** POSTs the payload, retrying with backoff. 409 means the api already has this job's result. Never throws. */
export async function postResult(url: string, payload: ResultPayload, opts: PostOptions = {}): Promise<boolean> {
	const { fetchFn = fetch, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)), attempts = 5, token } = opts;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const res = await fetchFn(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...(token ? { "x-result-token": token } : {}) },
				body: JSON.stringify(payload),
			});
			if (res.ok || res.status === 409) return true;
			console.error(`[results] api returned ${res.status} (attempt ${attempt}/${attempts})`);
		} catch (err) {
			console.error(`[results] post failed (attempt ${attempt}/${attempts}): ${err}`);
		}
		if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
	}
	return false;
}
