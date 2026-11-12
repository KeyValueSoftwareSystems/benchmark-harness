/**
 * PA-specific metrics: per-assistant, optionally split by world category.
 * The existing latestPerChallenge de-duplicates re-runs of the same world.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelFile, RunRecord } from "../../shared/results.ts";
import { latestPerChallenge } from "../metrics.ts";

// ---------------------------------------------------------------------------
// Types — the PA score shape as stored in outcome.score
// ---------------------------------------------------------------------------

interface PaScoreShape {
	total: number | null;
	safe: boolean | null;
	violations: { rule: string; source: string; tool?: string; evidence?: string }[];
	judgeFailed: boolean;
	toolCallCount: number | null;
	toolCallsByService: Record<string, number> | null;
	exchanges: number;
	category: string | null;
	llm: { paa: { calls: number; costUsd: number } };
}

export interface JudgeCalibration {
	judgeModel: string;
	labelled: number;
	agreement: number;
	selfAgreement: number | null;
	date: string;
}

// ---------------------------------------------------------------------------
// Per-world result (for the matrix)
// ---------------------------------------------------------------------------

export interface PaWorldResult {
	worldId: string;
	category: string;
	passed: boolean | null;
	score: number | null;
	safe: boolean | null;
	violations: PaScoreShape["violations"];
	durationMs: number;
	judgeFailed: boolean;
}

// ---------------------------------------------------------------------------
// Per-category metrics
// ---------------------------------------------------------------------------

export interface PaCategoryMetrics {
	category: string;
	passed: number;
	total: number;
	passRate: number;
	meanScore: number | null;
}

// ---------------------------------------------------------------------------
// Per-assistant aggregate
// ---------------------------------------------------------------------------

export interface PaAssistantMetrics {
	assistant: string;
	passed: number;
	total: number;
	passRate: number;
	meanScore: number | null;
	unsafeRuns: number;
	totalViolations: number;
	safetyDetails: PaScoreShape["violations"][];
	judgeFailures: number;
	verdicts: Record<string, number>;
	medianDurationMs: number | null;
	meanPaaCostUsd: number | null;
	costPerPassedTask: number | null;
	meanPaaLlmCalls: number | null;
	meanToolCalls: number | null;
	toolCallsByService: Record<string, number>;
	meanExchanges: number | null;
	categories: PaCategoryMetrics[];
	worlds: PaWorldResult[];
	/** Individual run durations for dot plots. */
	durations: { worldId: string; category: string; ms: number }[];
}

// ---------------------------------------------------------------------------
// Full report data
// ---------------------------------------------------------------------------

export interface PaReportData {
	model: string;
	assistants: PaAssistantMetrics[];
	allWorlds: string[];
	allCategories: string[];
	calibration: JudgeCalibration | null;
	conditions: string;
	runWindow: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

function median(values: number[]): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(values: number[]): number | null {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function paScore(run: RunRecord): PaScoreShape | undefined {
	return (run.outcome as Record<string, unknown> | null)?.score as PaScoreShape | undefined;
}

function personaVerdict(run: RunRecord): string | undefined {
	const v = (run.outcome as Record<string, unknown> | null)?.outcome;
	return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Compute metrics for one assistant's runs
// ---------------------------------------------------------------------------

function computeAssistantMetrics(assistant: string, runs: RunRecord[]): PaAssistantMetrics {
	const latest = latestPerChallenge(runs);

	const scores = latest.map((r) => paScore(r));
	const totals = scores.map((s) => s?.total).filter((t): t is number => t !== null);
	const passed = latest.filter((r) => r.correct === true).length;
	const total = latest.length;

	// Safety
	let unsafeRuns = 0;
	let totalViolations = 0;
	const safetyDetails: PaScoreShape["violations"][] = [];
	for (const s of scores) {
		if (s && s.safe === false) {
			unsafeRuns++;
			totalViolations += s.violations.length;
			safetyDetails.push(s.violations);
		}
	}

	// Judge failures
	const judgeFailures = scores.filter((s) => s?.judgeFailed).length;

	// Verdicts
	const verdicts: Record<string, number> = {};
	for (const run of latest) {
		const v = personaVerdict(run);
		if (v) verdicts[v] = (verdicts[v] ?? 0) + 1;
	}

	// Cost
	const paaCosts = scores.map((s) => s?.llm.paa.costUsd).filter((c): c is number => c !== undefined);
	const totalCost = paaCosts.reduce((a, b) => a + b, 0);
	const costPerPassedTask = passed > 0 ? round(totalCost / passed, 4) : null;

	// Behavior
	const paaCalls = scores.map((s) => s?.llm.paa.calls).filter((c): c is number => c !== undefined);
	const toolCounts = scores.map((s) => s?.toolCallCount).filter((c): c is number => c !== null);
	const exchanges = scores.map((s) => s?.exchanges).filter((e): e is number => e !== undefined);
	const toolsByService: Record<string, number> = {};
	for (const s of scores) {
		if (!s?.toolCallsByService) continue;
		for (const [svc, n] of Object.entries(s.toolCallsByService)) toolsByService[svc] = (toolsByService[svc] ?? 0) + n;
	}

	// Categories
	const catMap = new Map<string, RunRecord[]>();
	for (const run of latest) {
		const cat = paScore(run)?.category ?? "unknown";
		if (!catMap.has(cat)) catMap.set(cat, []);
		catMap.get(cat)!.push(run);
	}
	const categories = [...catMap.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([category, catRuns]): PaCategoryMetrics => {
			const p = catRuns.filter((r) => r.correct === true).length;
			const t = catRuns.length;
			const catTotals = catRuns.map((r) => paScore(r)?.total).filter((v): v is number => v !== null);
			return { category, passed: p, total: t, passRate: t ? round((p / t) * 100) : 0, meanScore: catTotals.length ? round(mean(catTotals)!, 2) : null };
		});

	// Per-world results
	const worlds = latest.map((run): PaWorldResult => {
		const s = paScore(run);
		return {
			worldId: run.challenge ?? run.jobId,
			category: s?.category ?? "unknown",
			passed: run.correct,
			score: s?.total ?? null,
			safe: s?.safe ?? null,
			violations: s?.violations ?? [],
			durationMs: run.metrics.durationMs,
			judgeFailed: s?.judgeFailed ?? false,
		};
	}).sort((a, b) => a.category.localeCompare(b.category) || a.worldId.localeCompare(b.worldId));

	// Durations for dot plots
	const durations = latest.map((run) => ({
		worldId: run.challenge ?? run.jobId,
		category: paScore(run)?.category ?? "unknown",
		ms: run.metrics.durationMs,
	}));

	return {
		assistant,
		passed,
		total,
		passRate: total ? round((passed / total) * 100) : 0,
		meanScore: totals.length ? round(mean(totals)!, 2) : null,
		unsafeRuns,
		totalViolations,
		safetyDetails,
		judgeFailures,
		verdicts,
		medianDurationMs: median(latest.map((r) => r.metrics.durationMs)),
		meanPaaCostUsd: mean(paaCosts) !== null ? round(mean(paaCosts)!, 4) : null,
		costPerPassedTask,
		meanPaaLlmCalls: mean(paaCalls) !== null ? round(mean(paaCalls)!, 1) : null,
		meanToolCalls: mean(toolCounts) !== null ? round(mean(toolCounts)!, 1) : null,
		toolCallsByService: toolsByService,
		meanExchanges: mean(exchanges) !== null ? round(mean(exchanges)!, 1) : null,
		categories,
		worlds,
		durations,
	};
}

// ---------------------------------------------------------------------------
// Build the full report data from one model file
// ---------------------------------------------------------------------------

function describeConditions(runs: RunRecord[]): string {
	if (!runs.length) return "";
	if (new Set(runs.map((r) => JSON.stringify(r.conditions))).size > 1) return "Mixed run conditions";
	const c = runs[0].conditions ?? {};
	const turns = typeof c.maxTurns === "number" ? `${c.maxTurns} turns max` : "unlimited turns";
	const limit = typeof c.jobTimeoutMs === "number" ? `${Math.round((c.jobTimeoutMs as number) / 60_000)} min limit` : "no time limit";
	return `${turns} · ${limit}`;
}

function describeRunWindow(runs: RunRecord[]): string {
	if (!runs.length) return "";
	const dates = runs.map((r) => r.createdAt).filter(Boolean).sort();
	const first = dates[0];
	const last = dates[dates.length - 1];
	if (!first) return "";
	const fmt = (d: string) => new Date(d).toUTCString().replace(" GMT", " UTC");
	return first === last ? fmt(first) : `${fmt(first)} – ${fmt(last)}`;
}

export function computePaReportData(file: ModelFile, assistantNames: string[]): PaReportData {
	const byAssistant = new Map<string, RunRecord[]>();
	for (const name of assistantNames) byAssistant.set(name, []);
	for (const run of file.runs) {
		const a = run.assistant ?? "unknown";
		if (byAssistant.has(a)) byAssistant.get(a)!.push(run);
	}

	const assistants = assistantNames.map((name) => computeAssistantMetrics(name, byAssistant.get(name) ?? []));

	const allWorlds = [...new Set(assistants.flatMap((a) => a.worlds.map((w) => w.worldId)))].sort();
	const allCategories = [...new Set(assistants.flatMap((a) => a.categories.map((c) => c.category)))].sort();
	const allRuns = assistantNames.flatMap((name) => byAssistant.get(name) ?? []);

	return {
		model: file.model,
		assistants,
		allWorlds,
		allCategories,
		calibration: null, // loaded separately by generate
		conditions: describeConditions(allRuns),
		runWindow: describeRunWindow(allRuns),
	};
}

export async function loadCalibration(resourcesDir: string): Promise<JudgeCalibration | null> {
	try {
		const raw = await readFile(path.join(resourcesDir, "pa", "judge-calibration.json"), "utf8");
		return JSON.parse(raw) as JudgeCalibration;
	} catch {
		return null;
	}
}
