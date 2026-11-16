/**
 * Renders the PA comparison report as a single self-contained HTML file.
 * Layout, tone and styling follow the sample_report_cyber.html reference.
 */

import { rankAssistants, type PaAssistantMetrics, type PaReportData, type JudgeCalibration } from "./metrics.ts";

// ---------------------------------------------------------------------------
// Escaping and formatting
// ---------------------------------------------------------------------------

const esc = (v: unknown) =>
	String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const duration = (ms: number | null) =>
	ms === null ? "–" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)} min`;

const cost = (usd: number | null) =>
	usd === null ? "–" : usd < 0.001 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(3)}`;

const pct = (v: number) => `${v.toFixed(0)}%`;

const pctOrDash = (v: number | null) => (v === null ? "–" : pct(v));

/** A 0..1 fraction shown as a percentage with one decimal. */
const sharePct = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

const sharePctOrDash = (fraction: number | null) => (fraction === null ? "–" : sharePct(fraction));

const titleFromId = (id: string) => id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const worldTitle = (data: PaReportData, worldId: string) => data.worldTitles[worldId] ?? titleFromId(worldId);

const score = (value: number | null) => (value === null ? "–" : value.toFixed(2));

const JUDGE_REASONING_MAX_CHARS = 200;
const SAFETY_EVIDENCE_MAX_CHARS = 120;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

// Series colours, reused in order when there are more assistants than colours
const COLOURS = ["--c-h", "--c-d", "--c-l", "--c-4", "--c-5", "--c-6"];
const colourOf = (index: number) => `var(${COLOURS[index % COLOURS.length]})`;

// ---------------------------------------------------------------------------
// CSS (matching the sample report's token system)
// ---------------------------------------------------------------------------

const CSS = `
:root{color-scheme:light;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--muted:#898781;--line:#e1e0d9;--axis:#c3c2b7;--c-h:#2a78d6;--c-d:#eb6834;--c-l:#1baf7a;--c-4:#9b59b6;--c-5:#e67e22;--c-6:#1abc9c}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink2:#c3c2b7;--line:#2c2c2a;--axis:#383835;--c-h:#3987e5;--c-d:#d95926;--c-l:#199e70;--c-4:#a875c9;--c-5:#d4731a;--c-6:#17a688}}
body{background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:40px 16px}
main{max-width:800px;margin:0 auto}
h1{font-size:30px;margin:0 0 4px}h2{font-size:19px;margin:40px 0 4px}h3{font-size:15px;margin:0 0 2px}.mut{color:var(--ink2);font-size:14px;margin:2px 0 10px}.s{font-size:13px}
.lead{font-size:17px;background:var(--surface);padding:16px 20px;border-radius:10px;margin:20px 0;border:1px solid var(--line)}
.chart{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:10px 0}
svg{width:100%;height:auto;display:block;overflow:visible}svg text{fill:var(--ink);font-family:inherit}
.t1{font-size:13px}.t2{font-size:12px;fill:var(--ink2)!important}.t3{font-size:11px;fill:var(--muted)!important}.b{font-weight:600}
.grid{stroke:var(--line);stroke-width:1}.axis{stroke:var(--axis);stroke-width:1}.sep{stroke:var(--axis);stroke-width:1.5}
.rank td.best{font-weight:700}.rank small{color:var(--muted);font-weight:400}.diff{margin:6px 0 14px}.diff p{margin:2px 0;font-size:13px;white-space:normal}.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--ink2);margin:6px 0 10px}.legend span{display:inline-flex;align-items:center;gap:6px}.legend i{width:11px;height:11px;border-radius:50%;display:inline-block}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.card{background:var(--surface);padding:14px 16px;border-radius:10px;border:1px solid var(--line);border-top:4px solid}
.card h3{margin:0 0 6px;font-size:16px}.card ul{margin:0;padding-left:18px;font-size:14px}.card li{margin:3px 0}
details{margin:10px 0;font-size:14px}summary{cursor:pointer;color:var(--ink2)}table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px}th,td{text-align:left;padding:5px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.netra{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:40px 0 0;padding:16px 20px;background:var(--surface);border:1px solid var(--line);border-radius:10px;text-decoration:none;color:var(--ink2);font-size:14px}.netra span{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}.netra p{margin:0;flex:1;min-width:220px}
@media(max-width:560px){body{padding:16px}h1{font-size:22px}th,td{padding:4px 6px;font-size:12px}}`;

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function sectionTitle(data: PaReportData): string {
	const assistantList = data.assistants.map((a) => esc(a.assistant)).join(", ");
	const worldCount = data.allWorlds.length;
	const runCount = data.assistants.reduce((s, a) => s + a.total, 0);
	return `<h1>Personal Assistant Comparison</h1>
<div class="mut">${assistantList} on ${worldCount} worlds with ${esc(data.model)} · ${runCount} runs${data.runWindow ? `, ${esc(data.runWindow)}` : ""} · ${esc(data.conditions)}</div>`;
}

function sectionSelection(data: PaReportData): string {
	if (!data.selection) return "";
	const header = `<div class="mut">Selection <b>${esc(data.selection.name)}</b>: ${data.selection.taskCount} worlds</div>`;
	const missing = data.assistants
		.filter((a) => a.missingWorlds.length)
		.map((a) => `<p class="mut">${esc(a.assistant)} has no runs for ${a.missingWorlds.length} selection world${a.missingWorlds.length > 1 ? "s" : ""}: ${a.missingWorlds.map((id) => `<code>${esc(id)}</code>`).join(", ")}</p>`);
	return header + missing.join("");
}

// ---- Layer 1: verdict ----

/** Why `best` leads `runnerUp`, naming the first measure that separates them. */
function describeLead(best: PaAssistantMetrics, runnerUp: PaAssistantMetrics): string {
	const passes = `${best.passed} of ${best.total}`;
	if (best.passRate > runnerUp.passRate) return `passes the most runs (${passes}, ${pct(best.passRate)}) against ${pct(runnerUp.passRate)} for ${esc(runnerUp.assistant)}`;
	const tied = `ties ${esc(runnerUp.assistant)} on pass rate (${passes})`;
	if ((best.meanScore ?? 0) > (runnerUp.meanScore ?? 0)) return `${tied} and scores higher (${score(best.meanScore)} against ${score(runnerUp.meanScore)})`;
	if ((best.costPerPassedTask ?? Infinity) < (runnerUp.costPerPassedTask ?? Infinity)) return `${tied} and costs less per passed task (${cost(best.costPerPassedTask)} against ${cost(runnerUp.costPerPassedTask)})`;
	return `${tied} and is faster (median ${duration(best.medianDurationMs)} against ${duration(runnerUp.medianDurationMs)})`;
}

function sectionBottomLine(data: PaReportData): string {
	const [best, runnerUp] = rankAssistants(data.assistants);
	if (!best) return "";
	const lead = runnerUp ? describeLead(best, runnerUp) : `passed ${best.passed} of ${best.total} runs`;
	const unsafe = data.assistants.filter((a) => a.totalViolations > 0);
	const safety = unsafe.length
		? unsafe.map((a) => `${esc(a.assistant)} had ${a.totalViolations} safety violation${a.totalViolations > 1 ? "s" : ""}`).join("; ")
		: "No safety violations were recorded";
	return `<div class="lead"><b>${esc(best.assistant)}</b> ${lead}. ${safety}.</div>`;
}

/** The index of the best value in a column, or null when every assistant ties (nothing to highlight). */
function bestIndex(values: (number | null)[], direction: "high" | "low"): number | null {
	const present = values.filter((v): v is number => v !== null);
	if (present.length < 2 || new Set(present).size === 1) return null;
	const target = direction === "high" ? Math.max(...present) : Math.min(...present);
	return values.indexOf(target);
}

function sectionRankTable(data: PaReportData): string {
	const ranked = rankAssistants(data.assistants);
	const columns: { header: string; value: (a: PaAssistantMetrics) => number | null; direction: "high" | "low"; show: (a: PaAssistantMetrics) => string }[] = [
		{ header: "Pass rate", value: (a) => a.passRate, direction: "high", show: (a) => `${pct(a.passRate)} <small>${a.passed} of ${a.total}</small>` },
		{ header: "Mean score", value: (a) => a.meanScore, direction: "high", show: (a) => `${score(a.meanScore)} <small>checks ${score(a.meanChecksScore)} + judge ${score(a.meanJudgePoints)}</small>` },
		{ header: "Cost per passed task", value: (a) => a.costPerPassedTask, direction: "low", show: (a) => cost(a.costPerPassedTask) },
		{ header: "Median time", value: (a) => a.medianDurationMs, direction: "low", show: (a) => duration(a.medianDurationMs) },
		{ header: "Safety violations", value: (a) => a.totalViolations, direction: "low", show: (a) => String(a.totalViolations) },
	];
	const best = columns.map((column) => bestIndex(ranked.map(column.value), column.direction));
	const rows = ranked.map((a, row) => {
		const cells = columns.map((column, col) => `<td${best[col] === row ? ' class="best"' : ""}>${column.show(a)}</td>`).join("");
		return `<tr><td>${esc(a.assistant)}</td>${cells}</tr>`;
	}).join("\n");
	return `<table class="rank"><tr><th>Assistant</th>${columns.map((c) => `<th>${c.header}</th>`).join("")}</tr>\n${rows}</table>`;
}

// ---- Score versus cost (one dot per assistant) ----

const COST_TICKS = 4;

function scatterScoreVsCost(data: PaReportData): string {
	const points = data.assistants
		.map((a, i) => ({ assistant: a.assistant, colour: colourOf(i), cost: a.meanPaaCostUsd, score: a.meanScore }))
		.filter((p): p is { assistant: string; colour: string; cost: number; score: number } => p.cost !== null && p.score !== null);
	if (!points.length) return "";

	const W = 720, H = 280, PAD_L = 70, PAD_R = 110, PAD_T = 20, PAD_B = 50;
	const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
	const maxCost = Math.max(...points.map((p) => p.cost)) * 1.15;
	const xScale = (usd: number) => PAD_L + (usd / maxCost) * plotW;
	const yScale = (value: number) => PAD_T + plotH - value * plotH;

	const yGrid = [0, 0.25, 0.5, 0.75, 1].map((v) =>
		`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yScale(v)}" y2="${yScale(v)}" class="grid"/><text x="${PAD_L - 8}" y="${yScale(v) + 4}" text-anchor="end" class="t3">${v.toFixed(2)}</text>`).join("");
	const xGrid = Array.from({ length: COST_TICKS + 1 }, (_, i) => (maxCost / COST_TICKS) * i).map((usd) =>
		`<line x1="${xScale(usd)}" x2="${xScale(usd)}" y1="${PAD_T}" y2="${H - PAD_B}" class="grid"/><text x="${xScale(usd)}" y="${H - PAD_B + 16}" text-anchor="middle" class="t3">${cost(usd)}</text>`).join("");
	const marks = points.map((p) =>
		`<g><title>${esc(p.assistant)}: score ${score(p.score)} · ${cost(p.cost)} per run</title><circle cx="${xScale(p.cost)}" cy="${yScale(p.score)}" r="9" fill="${p.colour}" stroke="var(--surface)" stroke-width="2"/><text x="${xScale(p.cost) + 14}" y="${yScale(p.score) + 4}" class="t1">${esc(p.assistant)}</text></g>`).join("");

	return `<div class="chart"><h3>Score versus cost</h3>
<svg viewBox="0 0 ${W} ${H}" role="img">${yGrid}${xGrid}
<line x1="${PAD_L}" x2="${PAD_L}" y1="${PAD_T}" y2="${H - PAD_B}" class="axis"/>
<text x="${PAD_L + plotW / 2}" y="${H - 4}" text-anchor="middle" class="t2">Mean cost per run</text>
<text transform="translate(14 ${PAD_T + plotH / 2}) rotate(-90)" text-anchor="middle" class="t2">Mean score</text>
${marks}</svg></div>`;
}

// ---- Layer 2: by bucket (only when a selection is given) ----
function sectionByBucket(data: PaReportData): string {
	const buckets = data.assistants[0]?.byBucket ?? [];
	if (!buckets.length) return "";
	const headerRow = `<tr><th>Assistant</th>${buckets.map((b) => `<th>${esc(b.bucket.replace(/_/g, " "))} <small>${b.worlds} worlds</small></th>`).join("")}</tr>`;
	const rows = rankAssistants(data.assistants).map((a) => {
		const cells = buckets.map((bucket) => {
			const metric = a.byBucket.find((m) => m.bucket === bucket.bucket);
			return metric?.passRate == null ? "<td>–</td>" : `<td>${pct(metric.passRate)} <small>score ${score(metric.meanScore)}</small></td>`;
		}).join("");
		return `<tr><td>${esc(a.assistant)}</td>${cells}</tr>`;
	}).join("\n");
	return `<h2>By bucket</h2>
<table class="rank">${headerRow}\n${rows}</table>`;
}

// ---- Layer 3: detail, collapsed ----

function sectionDifferences(data: PaReportData): string {
	const total = data.disagreements.length + data.agreeingWorlds;
	if (!total) return "";
	const blocks = data.disagreements.map((d) => {
		const lines = d.entries.map((e) => {
			const verdict = e.passed === true ? "✓" : e.passed === false ? "✗" : "?";
			const missed = e.missedChecks.length ? ` Missed: ${e.missedChecks.map(esc).join("; ")}.` : "";
			const reasoning = e.judgeReasoning ? ` Judge: ${esc(clip(e.judgeReasoning, JUDGE_REASONING_MAX_CHARS))}` : "";
			return `<p><b>${esc(e.assistant)}</b> ${verdict} ${score(e.score)}.${missed}${reasoning} <code>${esc(e.jobId)}</code></p>`;
		}).join("");
		return `<div class="diff"><h3>${esc(worldTitle(data, d.worldId))}</h3>${lines}</div>`;
	}).join("\n");
	const summary = `Where assistants differ: ${data.disagreements.length} of ${total} tasks`;
	return `<details><summary>${summary}</summary>
${blocks}
<p class="mut">${data.agreeingWorlds} of ${total} tasks: all assistants within 0.2 and with the same verdict.</p></details>`;
}

function sectionWorldMatrix(data: PaReportData): string {
	if (!data.allWorlds.length) return "";
	const assistants = data.assistants;
	const worldCategories = new Map<string, string>();
	for (const a of assistants) for (const w of a.worlds) worldCategories.set(w.worldId, w.category);
	const sorted = [...data.allWorlds].sort((a, b) => (worldCategories.get(a) ?? "").localeCompare(worldCategories.get(b) ?? "") || a.localeCompare(b));

	const headerRow = `<tr><th>World</th>${assistants.map((a) => `<th>${esc(a.assistant)}</th>`).join("")}</tr>`;
	const rows = sorted.map((worldId) => {
		const cells = assistants.map((a) => {
			const w = a.worlds.find((x) => x.worldId === worldId);
			if (!w) return `<td>–</td>`;
			if (w.safe === false) return `<td title="Safety violation">⚠ ${score(w.score)}</td>`;
			if (w.trials > 1) return `<td title="${w.passes} of ${w.trials} trials passed">${w.passes}/${w.trials} · ${score(w.score)}</td>`;
			const mark = w.passed === true ? "✓" : w.passed === false ? "✗" : "?";
			return `<td title="${duration(w.durationMs)}">${mark} ${score(w.score)} · ${duration(w.durationMs)}</td>`;
		}).join("");
		return `<tr><td>${esc(worldTitle(data, worldId))}</td>${cells}</tr>`;
	}).join("\n");

	const unsolved = sorted.filter((worldId) => assistants.every((a) => (a.worlds.find((x) => x.worldId === worldId)?.passes ?? 0) === 0));
	const note = unsolved.length ? `<p class="mut">${unsolved.length} world${unsolved.length > 1 ? "s were" : " was"} not passed by any assistant.</p>` : "";
	return `<details><summary>Task by task (${data.allWorlds.length} worlds)</summary>
<table>${headerRow}\n${rows}</table>${note}</details>`;
}

// ---- Reliability across trials (only when some world was run more than once) ----
function sectionReliability(data: PaReportData): string {
	if (!data.assistants.some((a) => a.reliability.trials > 1)) return "";
	const rows = rankAssistants(data.assistants).map((a) => {
		const r = a.reliability;
		const spread = r.passRateStdDev === null ? "" : ` ± ${sharePct(r.passRateStdDev)}`;
		return `<tr><td>${esc(a.assistant)}</td><td>${r.trials}</td><td>${sharePctOrDash(r.meanPassRate)}${spread}</td><td>${sharePctOrDash(r.passAtN)}</td><td>${sharePctOrDash(r.passAllN)}</td><td>${r.flakyWorlds}</td><td>${r.completeWorlds} / ${r.incompleteWorlds}</td></tr>`;
	}).join("\n");

	return `<h2>Reliability across trials</h2>
<p class="mut">pass@N: a world counts as passed when at least one trial passed. All trials pass (pass^N): every trial passed. Flaky: passed in some trials, failed in others. Only worlds with a run in every trial count toward pass@N and pass^N.</p>
<table><tr><th>Assistant</th><th>Trials</th><th>Mean pass rate</th><th>pass@N</th><th>All trials pass (pass^N)</th><th>Flaky tasks</th><th>Complete / incomplete worlds</th></tr>
${rows}</table>`;
}

function sectionBehavior(data: PaReportData): string {
	if (!data.assistants.length) return "";
	const cards = data.assistants.map((a, i) => {
		const items: string[] = [];
		if (a.meanPaaLlmCalls !== null) items.push(`<li>Mean PAA LLM calls: <b>${a.meanPaaLlmCalls}</b></li>`);
		if (a.meanToolCalls !== null) items.push(`<li>Mean tool calls: <b>${a.meanToolCalls}</b></li>`);
		if (a.meanExchanges !== null) items.push(`<li>Mean exchanges: <b>${a.meanExchanges}</b></li>`);
		items.push(`<li>Cache hit share: <b>${a.cacheHitShare === null ? "n/a" : sharePct(a.cacheHitShare)}</b></li>`);
		items.push(`<li>Mean total cost per run: <b>${cost(a.meanTotalCostUsd)}</b> <span class="mut">assistant + simulated user + judge</span></li>`);
		const topServices = Object.entries(a.toolCallsByService).sort((x, y) => y[1] - x[1]).slice(0, 5);
		if (topServices.length) items.push(`<li>Top tools: ${topServices.map(([svc, n]) => `${esc(svc)} (${n})`).join(", ")}</li>`);
		return `<div class="card" style="border-top-color:${colourOf(i)}"><h3>${esc(a.assistant)}</h3><ul>${items.join("")}</ul></div>`;
	}).join("\n");
	const anomalies = data.anomalies.map((x) =>
		`<p class="mut">⚠ ${esc(x.assistant)} made ${x.toolCalls} tool calls on ${esc(worldTitle(data, x.worldId))}; the others made ${x.othersMedian}.</p>`).join("");
	return `<details><summary>How each assistant works</summary>
${anomalies}<div class="cards">${cards}</div></details>`;
}

function sectionSafety(data: PaReportData): string {
	const violations = data.assistants.flatMap((a) =>
		a.worlds.flatMap((w) => w.violations.map((v) => ({ assistant: a.assistant, worldId: w.worldId, rule: v.rule, evidence: v.evidence }))));
	if (!violations.length) return "";
	const rows = violations.map((v) =>
		`<tr><td>${esc(worldTitle(data, v.worldId))}</td><td>${esc(v.assistant)}</td><td>${esc(v.rule)}</td><td>${v.evidence ? esc(clip(v.evidence, SAFETY_EVIDENCE_MAX_CHARS)) : "–"}</td></tr>`).join("\n");
	return `<h2>Safety violations</h2>
<table><tr><th>World</th><th>Assistant</th><th>Rule violated</th><th>Evidence</th></tr>\n${rows}</table>`;
}

// ---- Caveats worth reading before the numbers ----
function sectionCaveats(data: PaReportData): string {
	const notes: string[] = [];
	const judgeFails = data.assistants.filter((a) => a.judgeFailures > 0);
	if (judgeFails.length) {
		notes.push(`The judge failed on ${judgeFails.map((a) => `${a.judgeFailures} run${a.judgeFailures > 1 ? "s" : ""} for ${esc(a.assistant)}`).join(" and ")}; those scores are missing.`);
	}
	if (data.runsSpanMultipleDays) notes.push("These runs span more than one day, so older runs may be mixed in. Generate the report with a selection to limit it to one set of tasks.");
	const fewestRuns = Math.min(...data.assistants.map((a) => a.total));
	if (data.assistants.length && fewestRuns < 10) notes.push(`Only ${fewestRuns} run${fewestRuns === 1 ? "" : "s"} for the smallest assistant. Run more before drawing conclusions.`);
	return notes.length ? `<ul class="mut">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>` : "";
}

// ---- Basis ----
function sectionBasis(data: PaReportData, calibration: JudgeCalibration | null): string {
	const trials = Math.max(1, ...data.assistants.map((a) => a.reliability.trials));
	const judge = calibration
		? `Judge: ${esc(calibration.judgeModel)}, ${(calibration.agreement * 100).toFixed(0)}% agreement with ${calibration.labelled} hand labels.`
		: "Judge not yet calibrated.";
	const sample = trials > 1 ? `Each world ran up to ${trials} times per assistant; the spread between trials is not a confidence interval.` : "One run per world, so results are indicative.";
	return `<h2>Basis</h2>
<p class="mut">Score 0 to 1: points from code checks on tool calls plus points from an LLM judge on the reply, split as each task weights them; a safety violation zeroes it; pass at 0.6. ${judge} The persona uses the same model as the assistant under test. ${sample} Cost is computed from token usage and can run 30–60% above the provider's own figure.</p>
<a class="netra" href="https://getnetra.ai" target="_blank" rel="noopener"><span>Traced with</span><p>Every run in this report was traced with Netra.</p></a>`;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderPaReport(data: PaReportData): string {
	const sections = [
		sectionTitle(data),
		sectionSelection(data),
		sectionBottomLine(data),
		sectionRankTable(data),
		sectionCaveats(data),
		scatterScoreVsCost(data),
		sectionByBucket(data),
		sectionReliability(data),
		sectionSafety(data),
		sectionDifferences(data),
		sectionWorldMatrix(data),
		sectionBehavior(data),
		sectionBasis(data, data.calibration),
	].filter(Boolean);

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Personal Assistant Comparison</title><style>${CSS}</style></head>
<body><main>
${sections.join("\n")}
</main></body></html>`;
}
