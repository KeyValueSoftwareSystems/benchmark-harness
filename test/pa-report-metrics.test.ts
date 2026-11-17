import assert from "node:assert/strict";
import test from "node:test";
import { computePaReportData, rankAssistants } from "../src/reports/pa/metrics.ts";
import { renderPaReport } from "../src/reports/pa/render.ts";
import { Bucket, type SelectionManifest, type SelectionTask } from "../src/pa/selection.ts";
import type { ModelFile, RunRecord } from "../src/shared/results.ts";

const ASSISTANT = "hermes";

interface SideOverrides {
	calls?: number;
	inputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costUsd?: number;
}

const side = (over: SideOverrides = {}) => ({ calls: 1, inputTokens: 100, costUsd: 0.01, ...over });

interface RunOptions {
	trial?: number;
	correct?: boolean;
}

/** A PA run whose stored score carries the given LLM sides; `judge` is left out on older runs. Passes unless `correct` says otherwise. */
function paRun(challenge: string, sides: { paa: SideOverrides; persona?: SideOverrides; judge?: SideOverrides }, options: RunOptions = {}): RunRecord {
	const llm: Record<string, unknown> = { paa: side(sides.paa), persona: side(sides.persona) };
	if (sides.judge) llm.judge = side(sides.judge);
	return {
		jobId: `job-${challenge}`,
		benchmark: "pa",
		model: "gpt-x",
		modelId: "m",
		challenge,
		assistant: ASSISTANT,
		trial: options.trial ?? 1,
		status: "done",
		correct: options.correct ?? true,
		outcome: { outcome: "completed", score: { total: 1, safe: true, violations: [], judgeFailed: false, toolCallCount: 0, toolCallsByService: {}, exchanges: 1, category: "calendar", llm } },
		metrics: { turns: 1, durationMs: 1000, inputTokens: 0, outputTokens: 0, costUsd: 0 },
		sessionId: null,
		traceIds: null,
		netraMetadata: null,
		conditions: {},
		createdAt: "2026-01-01T00:00:00Z",
		finishedAt: "2026-01-01T00:00:00Z",
	};
}

const fileWith = (runs: RunRecord[]): ModelFile => ({ benchmark: "pa", model: "gpt-x", modelId: "m", runs });

function metricsFor(runs: RunRecord[]) {
	const data = computePaReportData(fileWith(runs), [ASSISTANT]);
	return data.assistants[0];
}

test("cache hit share is cached input over all input across runs", () => {
	const metrics = metricsFor([
		paRun("w1", { paa: { inputTokens: 1000, cacheReadTokens: 400, cacheWriteTokens: 100 }, persona: {} }),
		paRun("w2", { paa: { inputTokens: 1000, cacheReadTokens: 200 }, persona: {} }),
	]);
	assert.equal(metrics.cacheHitShare, 0.3);
});

test("cache hit share is 0 for runs that carry input tokens but no cache fields", () => {
	const metrics = metricsFor([paRun("w1", { paa: { inputTokens: 500 }, persona: {} })]);
	assert.equal(metrics.cacheHitShare, 0);
});

test("cache hit share is rounded to three decimals", () => {
	const metrics = metricsFor([paRun("w1", { paa: { inputTokens: 3, cacheReadTokens: 1 }, persona: {} })]);
	assert.equal(metrics.cacheHitShare, 0.333);
});

test("cache hit share is null when there are no input tokens or no runs", () => {
	assert.equal(metricsFor([paRun("w1", { paa: { inputTokens: 0 }, persona: {} })]).cacheHitShare, null);
	assert.equal(metricsFor([]).cacheHitShare, null);
});

test("total cost adds the assistant, simulated user and judge", () => {
	const metrics = metricsFor([
		paRun("w1", { paa: { costUsd: 0.01 }, persona: { costUsd: 0.02 }, judge: { costUsd: 0.03 } }),
		paRun("w2", { paa: { costUsd: 0.03 }, persona: { costUsd: 0.01 }, judge: { costUsd: 0.02 } }),
	]);
	assert.equal(metrics.meanTotalCostUsd, 0.06);
	assert.equal(metrics.meanPaaCostUsd, 0.02);
});

test("older runs without a judge side count the assistant and simulated user only", () => {
	const metrics = metricsFor([paRun("w1", { paa: { costUsd: 0.01 }, persona: { costUsd: 0.02 } })]);
	assert.equal(metrics.meanTotalCostUsd, 0.03);
});

test("total cost is rounded to four decimals and null when there are no runs", () => {
	const metrics = metricsFor([paRun("w1", { paa: { costUsd: 0.1 }, persona: { costUsd: 0.02 }, judge: { costUsd: 0.003456 } })]);
	assert.equal(metrics.meanTotalCostUsd, 0.1235);
	assert.equal(metricsFor([]).meanTotalCostUsd, null);
});

test("the report shows the cache share and total cost rows, with n/a when there is no cache share", () => {
	const withCache = renderPaReport(computePaReportData(fileWith([paRun("w1", { paa: { inputTokens: 200, cacheReadTokens: 50 }, persona: {} })]), [ASSISTANT]));
	assert.match(withCache, /Cache hit share: <b>25\.0%<\/b>/);
	assert.match(withCache, /Mean total cost per run: <b>/);
	assert.match(withCache, /assistant \+ simulated user \+ judge/);

	const withoutCache = renderPaReport(computePaReportData(fileWith([]), [ASSISTANT]));
	assert.match(withoutCache, /Cache hit share: <b>n\/a<\/b>/);
});

// ---------------------------------------------------------------------------
// Trials, reliability, selections and buckets
// ---------------------------------------------------------------------------

const bareRun = (challenge: string, options?: RunOptions) => paRun(challenge, { paa: {}, persona: {} }, options);

/** One run per trial of a world; `outcomes[i]` is whether trial i + 1 passed. */
function runsAcrossTrials(challenge: string, outcomes: boolean[]): RunRecord[] {
	return outcomes.map((correct, index) => bareRun(challenge, { trial: index + 1, correct }));
}

function task(worldId: string, bucket: Bucket): SelectionTask {
	return { bucket, split: "test", bundle: "test", taskId: worldId, persona: "test", worldId, translated: false };
}

function selectionOf(tasks: SelectionTask[]): SelectionManifest {
	return { name: "test-selection", tasks };
}

function dataFor(runs: RunRecord[], selection: SelectionManifest | null = null) {
	return computePaReportData(fileWith(runs), [ASSISTANT], selection);
}

test("reliability over three trials gives per-trial pass rates, mean, std dev, pass@N and pass^N", () => {
	const reliability = metricsFor([
		...runsAcrossTrials("A", [true, true, true]),
		...runsAcrossTrials("B", [true, true, false]),
		...runsAcrossTrials("C", [false, false, false]),
		...runsAcrossTrials("D", [true, false]),
	]).reliability;

	assert.equal(reliability.trials, 3);
	assert.deepEqual(reliability.passRateByTrial, [
		{ trial: 1, passRate: 0.75, worlds: 4 },
		{ trial: 2, passRate: 0.5, worlds: 4 },
		{ trial: 3, passRate: 0.333, worlds: 3 },
	]);
	assert.equal(reliability.meanPassRate, 0.528);
	assert.equal(reliability.passRateStdDev, 0.21);
	assert.equal(reliability.completeWorlds, 3);
	assert.equal(reliability.incompleteWorlds, 1);
	assert.equal(reliability.passAtN, 0.667);
	assert.equal(reliability.passAllN, 0.333);
	assert.equal(reliability.flakyWorlds, 1);
});

test("a single trial keeps the std dev null and makes pass@1 equal pass^1", () => {
	const reliability = metricsFor([bareRun("A"), bareRun("B", { correct: false })]).reliability;

	assert.equal(reliability.trials, 1);
	assert.deepEqual(reliability.passRateByTrial, [{ trial: 1, passRate: 0.5, worlds: 2 }]);
	assert.equal(reliability.passRateStdDev, null);
	assert.equal(reliability.passAtN, 0.5);
	assert.equal(reliability.passAllN, 0.5);
	assert.equal(reliability.flakyWorlds, 0);
	assert.equal(reliability.incompleteWorlds, 0);
});

test("a world's trials collapse into one world result with its pass count", () => {
	const metrics = metricsFor([...runsAcrossTrials("A", [true, true, true]), ...runsAcrossTrials("B", [true, false, true])]);

	assert.equal(metrics.worlds.length, 2);
	assert.equal(metrics.total, 6);
	const worldA = metrics.worlds.find((w) => w.worldId === "A")!;
	const worldB = metrics.worlds.find((w) => w.worldId === "B")!;
	assert.deepEqual([worldA.passes, worldA.trials, worldA.passed], [3, 3, true]);
	assert.deepEqual([worldB.passes, worldB.trials, worldB.passed], [2, 3, null]);
});

test("byBucket groups selection worlds by bucket and missingWorlds lists worlds the assistant never ran", () => {
	const selection = selectionOf([task("w1", Bucket.work), task("w2", Bucket.work), task("w3", Bucket.personalFamily), task("w4", Bucket.selfEmployed)]);
	const data = dataFor(
		[
			paRun("w1", { paa: { costUsd: 0.01 }, persona: { costUsd: 0.01 } }),
			paRun("w2", { paa: { costUsd: 0.02 }, persona: { costUsd: 0.02 } }, { correct: false }),
			paRun("w3", { paa: { costUsd: 0.03 }, persona: { costUsd: 0.01 } }),
		],
		selection,
	);

	const metrics = data.assistants[0];
	assert.deepEqual(metrics.byBucket, [
		{ bucket: Bucket.work, worlds: 2, runs: 2, passRate: 50, meanScore: 1, meanTotalCostUsd: 0.03 },
		{ bucket: Bucket.personalFamily, worlds: 1, runs: 1, passRate: 100, meanScore: 1, meanTotalCostUsd: 0.04 },
		{ bucket: Bucket.selfEmployed, worlds: 1, runs: 0, passRate: null, meanScore: null, meanTotalCostUsd: null },
	]);
	assert.deepEqual(metrics.missingWorlds, ["w4"]);
	assert.deepEqual(data.selection, { name: "test-selection", taskCount: 4 });
});

test("runs outside the selection are dropped; without a selection there are no buckets and no coverage gaps", () => {
	const runs = [bareRun("w1"), bareRun("outside")];

	const scoped = dataFor(runs, selectionOf([task("w1", Bucket.work)]));
	assert.equal(scoped.assistants[0].total, 1);

	const unscoped = dataFor(runs);
	assert.equal(unscoped.assistants[0].total, 2);
	assert.deepEqual(unscoped.assistants[0].byBucket, []);
	assert.deepEqual(unscoped.assistants[0].missingWorlds, []);
	assert.equal(unscoped.selection, null);
});

test("the reliability and bucket sections render only when trials and a selection exist", () => {
	const selection = selectionOf([task("w1", Bucket.work)]);
	const withTrials = renderPaReport(dataFor([...runsAcrossTrials("w1", [true, false])], selection));
	assert.match(withTrials, /<h2>Reliability across trials<\/h2>/);
	assert.match(withTrials, /<h2>By bucket<\/h2>/);
	assert.match(withTrials, /Selection <b>test-selection<\/b>: 1 worlds/);

	const singleTrial = renderPaReport(dataFor([bareRun("w1")]));
	assert.doesNotMatch(singleTrial, /Reliability across trials/);
	assert.doesNotMatch(singleTrial, /By bucket/);
	assert.doesNotMatch(singleTrial, /Selection <b>/);
});

test("the report escapes world ids and lists the selection worlds an assistant is missing", () => {
	const html = renderPaReport(
		dataFor([bareRun('w<script>"x"')], selectionOf([task('w<script>"x"', Bucket.work), task("m<b>", Bucket.work)])),
	);
	assert.doesNotMatch(html, /<script>/);
	assert.match(html, /W&lt;Script&gt;&quot;X&quot;/);
	assert.match(html, /has no runs for 1 selection world: <code>m&lt;b&gt;<\/code>/);
});

// ---------------------------------------------------------------------------
// Ranking, disagreements, anomalies and layout
// ---------------------------------------------------------------------------

interface ScoredRun {
	assistant: string;
	world: string;
	total: number;
	correct: boolean;
	toolCalls?: number;
	missed?: string;
	reasoning?: string;
	createdAt?: string;
}

function scoredRun(options: ScoredRun): RunRecord {
	const base = paRun(options.world, { paa: {}, persona: {} }, { correct: options.correct });
	const outcome = base.outcome as { score: Record<string, unknown> };
	outcome.score = {
		...outcome.score,
		total: options.total,
		checksScore: options.total,
		judgeScore: options.total,
		judgeReasoning: options.reasoning ?? "",
		toolCallCount: options.toolCalls ?? 5,
		checks: options.missed ? [{ kind: "scoring", index: 0, name: options.missed, status: "fail" }] : [],
	};
	return { ...base, assistant: options.assistant, jobId: `job-${options.assistant}-${options.world}`, createdAt: options.createdAt ?? base.createdAt };
}

const multiAssistantData = (runs: RunRecord[], names: string[]) => computePaReportData(fileWith(runs), names);

test("a tie on pass rate is broken by mean score, then cost per passed task, then time", () => {
	const data = multiAssistantData(
		[
			scoredRun({ assistant: "openclaw", world: "w1", total: 0.8, correct: true }),
			scoredRun({ assistant: "hermes", world: "w1", total: 0.9, correct: true }),
		],
		["openclaw", "hermes"],
	);
	assert.deepEqual(rankAssistants(data.assistants).map((a) => a.assistant), ["hermes", "openclaw"]);
	assert.match(renderPaReport(data), /<b>hermes<\/b> ties openclaw on pass rate \(1 of 1\) and scores higher \(0\.90 against 0\.80\)/);
});

test("worlds where scores differ by more than 0.2 or verdicts differ are disagreements; the rest count as agreeing", () => {
	const data = multiAssistantData(
		[
			scoredRun({ assistant: "a", world: "close", total: 0.8, correct: true }),
			scoredRun({ assistant: "b", world: "close", total: 0.9, correct: true }),
			scoredRun({ assistant: "a", world: "far", total: 0.9, correct: true }),
			scoredRun({ assistant: "b", world: "far", total: 0.5, correct: false, missed: "Names the deadline", reasoning: "No deadline given" }),
		],
		["a", "b"],
	);
	assert.deepEqual(data.disagreements.map((d) => d.worldId), ["far"]);
	assert.equal(data.agreeingWorlds, 1);
	const loser = data.disagreements[0].entries.find((e) => e.assistant === "b")!;
	assert.deepEqual([loser.missedChecks, loser.judgeReasoning], [["Names the deadline"], "No deadline given"]);
	assert.match(renderPaReport(data), /Where assistants differ: 1 of 2 tasks/);
});

test("an assistant with far more tool calls than the others on a world is flagged", () => {
	const data = multiAssistantData(
		[
			scoredRun({ assistant: "a", world: "w1", total: 0.9, correct: true, toolCalls: 6 }),
			scoredRun({ assistant: "b", world: "w1", total: 0.9, correct: true, toolCalls: 34 }),
			scoredRun({ assistant: "a", world: "w2", total: 0.9, correct: true, toolCalls: 2 }),
			scoredRun({ assistant: "b", world: "w2", total: 0.9, correct: true, toolCalls: 7 }),
		],
		["a", "b"],
	);
	assert.deepEqual(data.anomalies, [{ assistant: "b", worldId: "w1", toolCalls: 34, othersMedian: 6 }]);
});

test("runs more than a day apart set the mixed-runs warning", () => {
	const runs = [
		scoredRun({ assistant: "a", world: "w1", total: 1, correct: true, createdAt: "2026-01-01T00:00:00Z" }),
		scoredRun({ assistant: "a", world: "w2", total: 1, correct: true, createdAt: "2026-01-05T00:00:00Z" }),
	];
	assert.equal(multiAssistantData(runs, ["a"]).runsSpanMultipleDays, true);
	assert.match(renderPaReport(multiAssistantData(runs, ["a"])), /span more than one day/);
	assert.equal(multiAssistantData([runs[0]], ["a"]).runsSpanMultipleDays, false);
});

test("world titles replace the id, and five assistants render one ranked row each", () => {
	const names = ["a1", "a2", "a3", "a4", "a5"];
	const runs = names.map((assistant, i) => scoredRun({ assistant, world: "w1", total: 0.5 + i / 10, correct: true }));
	const data = computePaReportData(fileWith(runs), names, null, { w1: "Plan the move" });
	const html = renderPaReport(data);
	assert.match(html, /Plan the move/);
	assert.equal((html.match(/<tr><td>a\d<\/td>/g) ?? []).length >= 5, true);
	assert.deepEqual(rankAssistants(data.assistants).map((a) => a.assistant), ["a5", "a4", "a3", "a2", "a1"]);
});

test("a cancelled run is not counted and does not replace a finished run of the same world and trial", () => {
	const finished = scoredRun({ assistant: "a", world: "w1", total: 0.9, correct: true, createdAt: "2026-01-01T00:00:00Z" });
	const cancelled = { ...scoredRun({ assistant: "a", world: "w1", total: 0.1, correct: false, createdAt: "2026-01-02T00:00:00Z" }), status: "cancelled" };
	const metrics = multiAssistantData([finished, cancelled], ["a"]).assistants[0];
	assert.deepEqual([metrics.total, metrics.passed, metrics.meanScore], [1, 1, 0.9]);

	const onlyCancelled = multiAssistantData([cancelled], ["a"]).assistants[0];
	assert.equal(onlyCancelled.total, 0);
});
