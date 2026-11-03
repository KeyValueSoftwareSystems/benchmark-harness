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

/** Returns false when a row for the job already exists. */
export function insertRun(db: DatabaseSync, run: RunRecord): boolean {
	const result = db
		.prepare(
			`INSERT OR IGNORE INTO runs (job_id, benchmark, model, model_id, challenge, status, correct, outcome, metrics,
				session_id, trace_ids, netra_metadata, conditions, created_at, finished_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
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
	return Number(result.changes) === 1;
}

export function updateNetraMetadata(db: DatabaseSync, jobId: string, metadata: unknown, traceIds: string[]): void {
	db.prepare("UPDATE runs SET netra_metadata = ?, trace_ids = ? WHERE job_id = ?").run(
		json(metadata),
		JSON.stringify(traceIds),
		jobId,
	);
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
