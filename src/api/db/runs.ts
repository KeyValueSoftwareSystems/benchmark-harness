import { DatabaseSync } from "node:sqlite";
import type { RunMetrics, RunRecord } from "../../shared/results.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
	job_id TEXT PRIMARY KEY,
	benchmark TEXT NOT NULL,
	model TEXT NOT NULL,
	model_id TEXT NOT NULL,
	challenge TEXT,
	status TEXT NOT NULL,
	correct INTEGER,
	outcome TEXT,
	metrics TEXT NOT NULL,
	session_id TEXT,
	trace_ids TEXT,
	netra_metadata TEXT,
	conditions TEXT NOT NULL,
	created_at TEXT NOT NULL,
	finished_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_benchmark_model ON runs (benchmark, model);
`;

/** Opens (and creates) the runs database. No WAL, so a read-only mount of the file works for readers. */
export function openDb(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = DELETE");
	db.exec(SCHEMA);
	return db;
}

const json = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value));
const parse = <T>(value: unknown): T | null => (typeof value === "string" ? (JSON.parse(value) as T) : null);

/**
 * Writes a settled job. A re-run of the same job replaces the earlier attempt (the latest attempt wins), so a
 * retried or re-queued job never keeps a stale verdict. Safe to call twice for one attempt.
 */
export function upsertRun(db: DatabaseSync, run: RunRecord): void {
	db.prepare(
		`INSERT INTO runs (job_id, benchmark, model, model_id, challenge, status, correct, outcome, metrics,
			session_id, trace_ids, netra_metadata, conditions, created_at, finished_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(job_id) DO UPDATE SET benchmark = excluded.benchmark, model = excluded.model,
			model_id = excluded.model_id, challenge = excluded.challenge, status = excluded.status,
			correct = excluded.correct, outcome = excluded.outcome, metrics = excluded.metrics,
			session_id = excluded.session_id,
			-- the same attempt (same Netra session) keeps insights already saved; a new attempt starts clean
			trace_ids = CASE WHEN runs.session_id IS excluded.session_id THEN COALESCE(excluded.trace_ids, runs.trace_ids) ELSE excluded.trace_ids END,
			netra_metadata = CASE WHEN runs.session_id IS excluded.session_id THEN COALESCE(excluded.netra_metadata, runs.netra_metadata) ELSE excluded.netra_metadata END,
			conditions = excluded.conditions,
			created_at = excluded.created_at, finished_at = excluded.finished_at`,
	).run(
		run.jobId,
		run.benchmark,
		run.model,
		run.modelId,
		run.challenge,
		run.status,
		run.correct === null ? null : run.correct ? 1 : 0,
		json(run.outcome),
		JSON.stringify(run.metrics),
		run.sessionId,
		json(run.traceIds),
		json(run.netraMetadata),
		JSON.stringify(run.conditions),
		run.createdAt,
		run.finishedAt,
	);
}

/**
 * Saves Netra data for a run, but only while the row still belongs to that run's Netra session: if the job was
 * re-run in the meantime (different session) the data is stale and is not written. Returns whether it was written.
 */
export function updateNetraMetadata(
	db: DatabaseSync,
	jobId: string,
	sessionId: string | null,
	metadata: unknown,
	traceIds: string[],
): boolean {
	const result = db
		.prepare("UPDATE runs SET netra_metadata = ?, trace_ids = ? WHERE job_id = ? AND session_id IS ?")
		.run(json(metadata), JSON.stringify(traceIds), jobId, sessionId);
	return Number(result.changes) === 1;
}

export function listRuns(db: DatabaseSync, filter: { benchmark?: string; model?: string }): RunRecord[] {
	const where: string[] = [];
	const args: string[] = [];
	if (filter.benchmark) (where.push("benchmark = ?"), args.push(filter.benchmark));
	if (filter.model) (where.push("model = ?"), args.push(filter.model));
	const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, job_id`;
	return (db.prepare(sql).all(...args) as Record<string, unknown>[]).map((r) => ({
		jobId: r.job_id as string,
		benchmark: r.benchmark as string,
		model: r.model as string,
		modelId: r.model_id as string,
		challenge: (r.challenge as string | null) ?? null,
		status: r.status as string,
		correct: r.correct === null ? null : r.correct === 1,
		outcome: parse<Record<string, unknown>>(r.outcome),
		metrics: parse<RunMetrics>(r.metrics) as RunMetrics,
		sessionId: (r.session_id as string | null) ?? null,
		traceIds: parse<string[]>(r.trace_ids),
		netraMetadata: parse<unknown>(r.netra_metadata),
		conditions: parse<Record<string, unknown>>(r.conditions) ?? {},
		createdAt: r.created_at as string,
		finishedAt: r.finished_at as string,
	}));
}
