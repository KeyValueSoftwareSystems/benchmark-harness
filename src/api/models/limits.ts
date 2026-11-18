const DEFAULT_QUEUE_LIMIT = 5;

/** How many items the page's queue may hold: `QUEUE_LIMIT`, a whole number of 1 or more, else 5. */
export function parseQueueLimit(raw: string | undefined): number {
	const n = Number(raw?.trim());
	return raw?.trim() && Number.isInteger(n) && n >= 1 ? n : DEFAULT_QUEUE_LIMIT;
}
