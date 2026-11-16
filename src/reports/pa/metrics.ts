/**
 * PA-specific metrics: per-assistant, optionally split by world category or by the buckets of a selection.
 * latestPerChallengeTrial de-duplicates re-runs of the same world within one trial; each trial then counts on its own.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ModelFile, RunRecord } from "../../shared/results.ts";
import { Bucket, type SelectionManifest } from "../../pa/selection.ts";
import { latestPerChallengeTrial } from "../metrics.ts";

const FIRST_TRIAL = 1;
const DISAGREEMENT_SCORE_GAP = 0.2;
const ANOMALY_TOOL_CALL_RATIO = 3;
const ANOMALY_MIN_EXTRA_TOOL_CALLS = 10;
const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Types — the PA score shape as stored in outcome.score
// ---------------------------------------------------------------------------

/** One side's usage as stored. Cache fields and the judge side are absent on older runs. */
interface LlmSideShape {
	calls: number;
	inputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd: number;
}

/** One grading check as stored. A `judge` status means the LLM judge decided it; its answer is in the matching item. */
interface CheckShape {
	kind: string;
	index: number;
	name: string;
	status: string;
}

interface JudgeItemShape {
	kind: string;
	index: number;
	counted: string;
}

interface PaScoreShape {
	total: number | null;
	checksScore?: number | null;
	judgeScore?: number | null;
	judgeWeight?: number;
	judgeReasoning?: string;
	checks?: CheckShape[];
	items?: JudgeItemShape[];
	safe: boolean | null;
	violations: { rule: string; source: string; tool?: string; evidence?: string }[];
	judgeFailed: boolean;
	toolCallCount: number | null;
	toolCallsByService: Record<string, number> | null;
	exchanges: number;
	category: string | null;
	llm: { paa: LlmSideShape; persona: LlmSideShape; judge?: LlmSideShape };
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

/** One world across its trials. `passed` is true when every trial passed, false when none did, null when they differ. */
export interface PaWorldResult {
	worldId: string;
	category: string;
	passed: boolean | null;
	passes: number;
	trials: number;
	score: number | null;
	safe: boolean | null;
	violations: PaScoreShape["violations"];
	durationMs: number;
	judgeFailed: boolean;
	/** Mean over trials of the points earned from code checks and from the judge; they add up to `score`. */
	checksScore: number | null;
	judgePoints: number | null;
	/** Names of the checks missed in any trial. */
	missedChecks: string[];
	/** The judge's reasoning from the lowest-scoring trial. */
	judgeReasoning: string;
	/** Mean tool calls per trial; null when no trial logged them. */
	toolCalls: number | null;
	/** Job of the lowest-scoring trial, to find its trace. */
	jobId: string;
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
// Reliability across trials and per-bucket metrics
// ---------------------------------------------------------------------------

export interface PaTrialPassRate {
	trial: number;
	/** Fraction of the trial's runs that passed, three decimals. */
	passRate: number;
	worlds: number;
}

export interface PaReliabilityMetrics {
	/** The largest number of trials any world has. */
	trials: number;
	passRateByTrial: PaTrialPassRate[];
	meanPassRate: number | null;
	/** Sample standard deviation of the per-trial pass rates; null with fewer than two trials. */
	passRateStdDev: number | null;
	/** Share of complete worlds where at least one trial passed. */
	passAtN: number | null;
	/** Share of complete worlds where every trial passed. */
	passAllN: number | null;
	/** Complete worlds with some but not all trials passing. */
	flakyWorlds: number;
	/** Worlds with a run for every trial 1..trials. */
	completeWorlds: number;
	incompleteWorlds: number;
}

export interface PaBucketMetrics {
	bucket: Bucket;
	/** Selection worlds in this bucket. */
	worlds: number;
	runs: number;
	/** Percent, one decimal; null when the assistant has no runs in the bucket. */
	passRate: number | null;
	meanScore: number | null;
	meanTotalCostUsd: number | null;
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
	/** Mean points per run earned from code checks and from the judge; they add up to `meanScore`. */
	meanChecksScore: number | null;
	meanJudgePoints: number | null;
	unsafeRuns: number;
	totalViolations: number;
	safetyDetails: PaScoreShape["violations"][];
	judgeFailures: number;
	verdicts: Record<string, number>;
	medianDurationMs: number | null;
	meanPaaCostUsd: number | null;
	/** Mean of assistant + simulated user + judge cost per scored run. */
	meanTotalCostUsd: number | null;
	/** Share of the assistant's input tokens that were served from the provider's cache. */
	cacheHitShare: number | null;
	costPerPassedTask: number | null;
	meanPaaLlmCalls: number | null;
	meanToolCalls: number | null;
	toolCallsByService: Record<string, number>;
	meanExchanges: number | null;
	categories: PaCategoryMetrics[];
	worlds: PaWorldResult[];
	/** Individual run durations for dot plots. */
	durations: { worldId: string; category: string; ms: number }[];
	reliability: PaReliabilityMetrics;
	/** Empty unless a selection is given. */
	byBucket: PaBucketMetrics[];
	/** Selection worlds with no run for this assistant; empty unless a selection is given. */
	missingWorlds: string[];
}

// ---------------------------------------------------------------------------
// Full report data
// ---------------------------------------------------------------------------

/** One assistant's result on a world where assistants differ. */
export interface PaDisagreementEntry {
	assistant: string;
	passed: boolean | null;
	score: number | null;
	missedChecks: string[];
	judgeReasoning: string;
	jobId: string;
}

/** A world where scores differ by more than DISAGREEMENT_SCORE_GAP, or where one assistant passed and another failed. */
export interface PaDisagreement {
	worldId: string;
	entries: PaDisagreementEntry[];
}

/** An assistant that made far more tool calls on a world than the other assistants did. */
export interface PaToolCallAnomaly {
	assistant: string;
	worldId: string;
	toolCalls: number;
	othersMedian: number;
}

export interface PaReportData {
	model: string;
	assistants: PaAssistantMetrics[];
	/** World id to the task name from its world.yaml; a world missing here is shown by its id. */
	worldTitles: Record<string, string>;
	disagreements: PaDisagreement[];
	/** Worlds run by two or more assistants whose scores stay within DISAGREEMENT_SCORE_GAP. */
	agreeingWorlds: number;
	anomalies: PaToolCallAnomaly[];
	/** True when the runs span more than one calendar day, a sign that older runs were mixed in. */
	runsSpanMultipleDays: boolean;
	allWorlds: string[];
	allCategories: string[];
	selection: { name: string; taskCount: number } | null;
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

function totalRunCostUsd(score: PaScoreShape): number {
	return score.llm.paa.costUsd + score.llm.persona.costUsd + (score.llm.judge?.costUsd ?? 0);
}

/** Cached input tokens over all input tokens; null when there were no input tokens. */
function cacheHitShare(paaSides: LlmSideShape[]): number | null {
	const inputTokens = paaSides.reduce((sum, side) => sum + side.inputTokens, 0);
	if (inputTokens === 0) return null;
	const cachedTokens = paaSides.reduce((sum, side) => sum + (side.cacheReadTokens ?? 0), 0);
	return round(cachedTokens / inputTokens, 3);
}

function personaVerdict(run: RunRecord): string | undefined {
	const v = (run.outcome as Record<string, unknown> | null)?.outcome;
	return typeof v === "string" ? v : undefined;
}

function averageTotalCostUsd(scores: PaScoreShape[]): number | null {
	const average = mean(scores.map(totalRunCostUsd));
	return average === null ? null : round(average, 4);
}

function isScore(score: PaScoreShape | undefined): score is PaScoreShape {
	return score !== undefined;
}

function groupByWorld(runs: RunRecord[]): Map<string, RunRecord[]> {
	const byWorld = new Map<string, RunRecord[]>();
	for (const run of runs) {
		const worldId = run.challenge ?? run.jobId;
		byWorld.set(worldId, [...(byWorld.get(worldId) ?? []), run]);
	}
	return byWorld;
}

function runsInSelection(runs: RunRecord[], selection: SelectionManifest): RunRecord[] {
	const worldIds = new Set(selection.tasks.map((task) => task.worldId));
	return runs.filter((run) => run.challenge !== null && worldIds.has(run.challenge));
}

function missingWorldIds(runs: RunRecord[], selection: SelectionManifest | null): string[] {
	if (!selection) return [];
	const presentWorldIds = new Set(runs.map((run) => run.challenge));
	return selection.tasks.map((task) => task.worldId).filter((worldId) => !presentWorldIds.has(worldId));
}

// ---------------------------------------------------------------------------
// Per-world results (one per world, across its trials)
// ---------------------------------------------------------------------------

function aggregatePassed(runs: RunRecord[]): boolean | null {
	if (runs.every((run) => run.correct === true)) return true;
	if (runs.every((run) => run.correct === false)) return false;
	return null;
}

/** False when any trial was unsafe; true when every trial reported safe. */
function aggregateSafe(scores: (PaScoreShape | undefined)[]): boolean | null {
	const safeFlags = scores.map((score) => score?.safe ?? null);
	if (safeFlags.includes(false)) return false;
	return safeFlags.every((safe) => safe === true) ? true : null;
}

function numbers(values: (number | null | undefined)[]): number[] {
	return values.filter((value): value is number => typeof value === "number");
}

function roundedMean(values: number[], digits: number): number | null {
	const average = mean(values);
	return average === null ? null : round(average, digits);
}

/** Checks the assistant did not satisfy: code checks that failed, and judge checks the judge did not count as yes. */
function missedCheckNames(score: PaScoreShape | undefined): string[] {
	const judgedAsMissed = new Set(
		(score?.items ?? []).filter((item) => item.counted !== "yes").map((item) => `${item.kind}:${item.index}`),
	);
	return (score?.checks ?? [])
		.filter((check) => (check.status === "judge" ? judgedAsMissed.has(`${check.kind}:${check.index}`) : check.status === "fail"))
		.map((check) => check.name);
}

/** The judge's share of the total: its rubric score times the weight the task gives the rubric. */
function judgePoints(score: PaScoreShape | undefined): number | null {
	return typeof score?.judgeScore === "number" && typeof score.judgeWeight === "number" ? score.judgeScore * score.judgeWeight : null;
}

function lowestScoringRun(runs: RunRecord[]): RunRecord {
	return runs.reduce((lowest, run) => ((paScore(run)?.total ?? 0) < (paScore(lowest)?.total ?? 0) ? run : lowest));
}

function computeWorldResult(worldId: string, runs: RunRecord[]): PaWorldResult {
	const scores = runs.map((run) => paScore(run));
	const averageScore = mean(numbers(scores.map((s) => s?.total)));
	const weakestRun = lowestScoringRun(runs);
	return {
		worldId,
		category: paScore(runs[0])?.category ?? "unknown",
		passed: aggregatePassed(runs),
		passes: runs.filter((run) => run.correct === true).length,
		trials: runs.length,
		score: averageScore === null ? null : round(averageScore, 2),
		safe: aggregateSafe(scores),
		violations: scores.flatMap((s) => s?.violations ?? []),
		durationMs: median(runs.map((run) => run.metrics.durationMs))!,
		judgeFailed: scores.some((s) => s?.judgeFailed ?? false),
		checksScore: roundedMean(numbers(scores.map((s) => s?.checksScore)), 2),
		judgePoints: roundedMean(numbers(scores.map(judgePoints)), 2),
		missedChecks: [...new Set(scores.flatMap(missedCheckNames))],
		judgeReasoning: paScore(weakestRun)?.judgeReasoning ?? "",
		toolCalls: roundedMean(numbers(scores.map((s) => s?.toolCallCount)), 1),
		jobId: weakestRun.jobId,
	};
}

function computeWorldResults(runs: RunRecord[]): PaWorldResult[] {
	return [...groupByWorld(runs)]
		.map(([worldId, worldRuns]) => computeWorldResult(worldId, worldRuns))
		.sort((a, b) => a.category.localeCompare(b.category) || a.worldId.localeCompare(b.worldId));
}

// ---------------------------------------------------------------------------
// Reliability across trials
// ---------------------------------------------------------------------------

function passRateOfTrial(runs: RunRecord[], trial: number): PaTrialPassRate {
	const trialRuns = runs.filter((run) => run.trial === trial);
	const passes = trialRuns.filter((run) => run.correct === true).length;
	return { trial, passRate: round(passes / trialRuns.length, 3), worlds: trialRuns.length };
}

function hasEveryTrial(worldRuns: RunRecord[], trials: number): boolean {
	const trialsRun = new Set(worldRuns.map((run) => run.trial));
	return Array.from({ length: trials }, (_, index) => FIRST_TRIAL + index).every((trial) => trialsRun.has(trial));
}

/** Sample standard deviation (n - 1); null with fewer than two values. */
function sampleStdDev(values: number[]): number | null {
	if (values.length < 2) return null;
	const average = mean(values)!;
	const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
	return round(Math.sqrt(variance), 3);
}

function shareOf(count: number, whole: number): number | null {
	return whole ? round(count / whole, 3) : null;
}

function computeReliability(runs: RunRecord[]): PaReliabilityMetrics {
	const worlds = [...groupByWorld(runs).values()];
	const trials = Math.max(0, ...worlds.map((worldRuns) => worldRuns.length));
	const complete = worlds.filter((worldRuns) => hasEveryTrial(worldRuns, trials));
	const passesOf = (worldRuns: RunRecord[]) => worldRuns.filter((run) => run.correct === true).length;

	const trialNumbers = [...new Set(runs.map((run) => run.trial))].sort((a, b) => a - b);
	const passRateByTrial = trialNumbers.map((trial) => passRateOfTrial(runs, trial));
	const trialRates = passRateByTrial.map((entry) => entry.passRate);
	const meanRate = mean(trialRates);

	return {
		trials,
		passRateByTrial,
		meanPassRate: meanRate === null ? null : round(meanRate, 3),
		passRateStdDev: sampleStdDev(trialRates),
		passAtN: shareOf(complete.filter((worldRuns) => passesOf(worldRuns) > 0).length, complete.length),
		passAllN: shareOf(complete.filter((worldRuns) => passesOf(worldRuns) === trials).length, complete.length),
		flakyWorlds: complete.filter((worldRuns) => passesOf(worldRuns) > 0 && passesOf(worldRuns) < trials).length,
		completeWorlds: complete.length,
		incompleteWorlds: worlds.length - complete.length,
	};
}

// ---------------------------------------------------------------------------
// Per-bucket metrics for a selection
// ---------------------------------------------------------------------------

function computeBucketMetric(bucket: Bucket, runs: RunRecord[], selection: SelectionManifest): PaBucketMetrics {
	const bucketWorldIds = new Set(selection.tasks.filter((task) => task.bucket === bucket).map((task) => task.worldId));
	const bucketRuns = runs.filter((run) => run.challenge !== null && bucketWorldIds.has(run.challenge));
	const passes = bucketRuns.filter((run) => run.correct === true).length;
	const scores = bucketRuns.map((run) => paScore(run)).filter(isScore);
	return {
		bucket,
		worlds: bucketWorldIds.size,
		runs: bucketRuns.length,
		passRate: bucketRuns.length ? round((passes / bucketRuns.length) * 100) : null,
		meanScore: roundedMean(numbers(scores.map((score) => score.total)), 2),
		meanTotalCostUsd: averageTotalCostUsd(scores),
	};
}

function computeBucketMetrics(runs: RunRecord[], selection: SelectionManifest): PaBucketMetrics[] {
	return Object.values(Bucket)
		.map((bucket) => computeBucketMetric(bucket, runs, selection))
		.filter((metric) => metric.worlds > 0);
}

// ---------------------------------------------------------------------------
// Compute metrics for one assistant's runs
// ---------------------------------------------------------------------------

function computeAssistantMetrics(assistant: string, runs: RunRecord[], selection: SelectionManifest | null): PaAssistantMetrics {
	const latest = latestPerChallengeTrial(runs);

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
	const scored = scores.filter((s): s is PaScoreShape => s != null);
	const scoredSides = scored.map((s) => s.llm.paa);
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
		meanChecksScore: roundedMean(numbers(scores.map((s) => s?.checksScore)), 2),
		meanJudgePoints: roundedMean(numbers(scores.map(judgePoints)), 2),
		unsafeRuns,
		totalViolations,
		safetyDetails,
		judgeFailures,
		verdicts,
		medianDurationMs: median(latest.map((r) => r.metrics.durationMs)),
		meanPaaCostUsd: mean(paaCosts) !== null ? round(mean(paaCosts)!, 4) : null,
		meanTotalCostUsd: averageTotalCostUsd(scored),
		cacheHitShare: cacheHitShare(scoredSides),
		costPerPassedTask,
		meanPaaLlmCalls: mean(paaCalls) !== null ? round(mean(paaCalls)!, 1) : null,
		meanToolCalls: mean(toolCounts) !== null ? round(mean(toolCounts)!, 1) : null,
		toolCallsByService: toolsByService,
		meanExchanges: mean(exchanges) !== null ? round(mean(exchanges)!, 1) : null,
		categories,
		worlds: computeWorldResults(latest),
		durations,
		reliability: computeReliability(latest),
		byBucket: selection ? computeBucketMetrics(latest, selection) : [],
		missingWorlds: missingWorldIds(latest, selection),
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

/** Best first: pass rate, then mean score, then cheaper per passed task, then faster. */
export function rankAssistants(assistants: PaAssistantMetrics[]): PaAssistantMetrics[] {
	const lowerIsBetter = (a: number | null, b: number | null) => (a ?? Infinity) - (b ?? Infinity);
	return [...assistants].sort(
		(a, b) =>
			b.passRate - a.passRate ||
			(b.meanScore ?? -1) - (a.meanScore ?? -1) ||
			lowerIsBetter(a.costPerPassedTask, b.costPerPassedTask) ||
			lowerIsBetter(a.medianDurationMs, b.medianDurationMs),
	);
}

interface AssistantWorld {
	assistant: string;
	result: PaWorldResult;
}

/** Every world with the results of the assistants that ran it, for worlds two or more assistants ran. */
function sharedWorlds(assistants: PaAssistantMetrics[]): Map<string, AssistantWorld[]> {
	const byWorld = new Map<string, AssistantWorld[]>();
	for (const a of assistants) {
		for (const result of a.worlds) byWorld.set(result.worldId, [...(byWorld.get(result.worldId) ?? []), { assistant: a.assistant, result }]);
	}
	return new Map([...byWorld].filter(([, entries]) => entries.length > 1));
}

function scoresDiffer(entries: AssistantWorld[]): boolean {
	const scores = numbers(entries.map((entry) => entry.result.score));
	const gap = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
	const verdicts = new Set(entries.map((entry) => entry.result.passed));
	return gap > DISAGREEMENT_SCORE_GAP || verdicts.size > 1;
}

function computeDisagreements(shared: Map<string, AssistantWorld[]>): { disagreements: PaDisagreement[]; agreeingWorlds: number } {
	const disagreements: PaDisagreement[] = [];
	for (const [worldId, entries] of shared) {
		if (!scoresDiffer(entries)) continue;
		disagreements.push({
			worldId,
			entries: entries.map(({ assistant, result }) => ({
				assistant,
				passed: result.passed,
				score: result.score,
				missedChecks: result.missedChecks,
				judgeReasoning: result.judgeReasoning,
				jobId: result.jobId,
			})),
		});
	}
	return { disagreements, agreeingWorlds: shared.size - disagreements.length };
}

function computeToolCallAnomalies(shared: Map<string, AssistantWorld[]>): PaToolCallAnomaly[] {
	const anomalies: PaToolCallAnomaly[] = [];
	for (const [worldId, entries] of shared) {
		for (const { assistant, result } of entries) {
			const others = numbers(entries.filter((entry) => entry.assistant !== assistant).map((entry) => entry.result.toolCalls));
			const othersMedian = median(others);
			if (result.toolCalls === null || othersMedian === null) continue;
			const farAboveOthers = result.toolCalls > othersMedian * ANOMALY_TOOL_CALL_RATIO;
			if (farAboveOthers && result.toolCalls - othersMedian >= ANOMALY_MIN_EXTRA_TOOL_CALLS) {
				anomalies.push({ assistant, worldId, toolCalls: result.toolCalls, othersMedian });
			}
		}
	}
	return anomalies;
}

function spansMultipleDays(runs: RunRecord[]): boolean {
	const times = runs.map((run) => Date.parse(run.createdAt)).filter(Number.isFinite);
	return times.length > 0 && Math.max(...times) - Math.min(...times) > MS_PER_DAY;
}

export function computePaReportData(
	file: ModelFile,
	assistantNames: string[],
	selection: SelectionManifest | null = null,
	worldTitles: Record<string, string> = {},
): PaReportData {
	const scopedRuns = selection ? runsInSelection(file.runs, selection) : file.runs;
	const byAssistant = new Map<string, RunRecord[]>();
	for (const name of assistantNames) byAssistant.set(name, []);
	for (const run of scopedRuns) {
		const a = run.assistant ?? "unknown";
		if (byAssistant.has(a)) byAssistant.get(a)!.push(run);
	}

	const assistants = assistantNames.map((name) => computeAssistantMetrics(name, byAssistant.get(name) ?? [], selection));

	const allWorlds = [...new Set(assistants.flatMap((a) => a.worlds.map((w) => w.worldId)))].sort();
	const allCategories = [...new Set(assistants.flatMap((a) => a.categories.map((c) => c.category)))].sort();
	const allRuns = assistantNames.flatMap((name) => byAssistant.get(name) ?? []);
	const shared = sharedWorlds(assistants);

	return {
		model: file.model,
		assistants,
		worldTitles,
		...computeDisagreements(shared),
		anomalies: computeToolCallAnomalies(shared),
		runsSpanMultipleDays: spansMultipleDays(allRuns),
		allWorlds,
		allCategories,
		selection: selection ? { name: selection.name, taskCount: selection.tasks.length } : null,
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
