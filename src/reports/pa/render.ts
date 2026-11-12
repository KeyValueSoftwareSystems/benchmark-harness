/**
 * Renders the PA comparison report as a single self-contained HTML file.
 * Layout, tone and styling follow the sample_report_cyber.html reference.
 */

import type { PaReportData, JudgeCalibration } from "./metrics.ts";

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

const shortWorld = (id: string) =>
	id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);

// Series colours (up to 6 assistants)
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
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--ink2);margin:6px 0 10px}.legend span{display:inline-flex;align-items:center;gap:6px}.legend i{width:11px;height:11px;border-radius:50%;display:inline-block}
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
<div class="mut">${esc(assistantList)} on ${worldCount} worlds with ${esc(data.model)} · ${runCount} runs${data.runWindow ? `, ${esc(data.runWindow)}` : ""} · ${esc(data.conditions)}</div>`;
}

function sectionBottomLine(data: PaReportData): string {
	const sorted = [...data.assistants].sort((a, b) => b.passRate - a.passRate);
	const best = sorted[0];
	if (!best) return "";
	const parts: string[] = [];
	parts.push(`<b>${esc(best.assistant)}</b> passes the most worlds (${best.passed} of ${best.total}, ${pct(best.passRate)})`);
	if (best.costPerPassedTask !== null) parts.push(`at <b>${cost(best.costPerPassedTask)}</b> per passed task`);
	const unsafe = data.assistants.filter((a) => a.totalViolations > 0);
	if (unsafe.length) {
		parts.push(`. ${unsafe.map((a) => `${esc(a.assistant)} had ${a.totalViolations} safety violation${a.totalViolations > 1 ? "s" : ""}`).join("; ")}`);
	} else {
		parts.push(". No safety violations were recorded.");
	}
	return `<div class="lead"><b>Bottom line.</b> ${parts.join("")}</div>`;
}

function sectionLegend(data: PaReportData): string {
	return `<div class="legend">${data.assistants.map((a, i) => `<span><i style="background:${colourOf(i)}"></i>${esc(a.assistant)}</span>`).join("")}</div>`;
}

// ---- At a glance: pass rate vs cost scatter (log scale) ----
function scatterPassVsCost(data: PaReportData): string {
	const hasCost = data.assistants.some((a) => a.categories.some((c) => {
		const catRuns = a.worlds.filter((w) => w.category === c.category);
		return catRuns.length > 0;
	}));
	if (!hasCost) return "";

	const W = 720, H = 300, PAD_L = 70, PAD_R = 30, PAD_T = 20, PAD_B = 50;
	const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;

	// Per-assistant overall cost (per-category cost breakdown not available)
	const costs = data.assistants.map((a) => a.meanPaaCostUsd).filter((c): c is number => c !== null && c > 0);
	if (!costs.length) return "";

	const minCost = Math.min(...costs) * 0.5;
	const maxCost = Math.max(...costs) * 2;
	const logScale = (v: number) => {
		if (v <= 0) return PAD_L;
		const logMin = Math.log10(minCost), logMax = Math.log10(maxCost);
		return PAD_L + ((Math.log10(v) - logMin) / (logMax - logMin)) * plotW;
	};
	const yScale = (rate: number) => PAD_T + plotH - (rate / 100) * plotH;

	const gridLines = [0, 25, 50, 75, 100].map((p) =>
		`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yScale(p)}" y2="${yScale(p)}" class="grid"/><text x="${PAD_L - 8}" y="${yScale(p) + 4}" text-anchor="end" class="t3">${p}%</text>`
	).join("");

	// X axis ticks at powers of 10
	const xTicks: string[] = [];
	for (let p = -4; p <= 2; p++) {
		const v = 10 ** p;
		if (v >= minCost && v <= maxCost) {
			const x = logScale(v);
			xTicks.push(`<line x1="${x}" x2="${x}" y1="${PAD_T}" y2="${H - PAD_B}" class="grid"/><text x="${x}" y="${H - PAD_B + 16}" text-anchor="middle" class="t3">${cost(v)}</text>`);
		}
	}

	const marks = data.assistants.map((a, i) => {
		if (a.meanPaaCostUsd === null || a.meanPaaCostUsd <= 0) return "";
		const x = logScale(a.meanPaaCostUsd), y = yScale(a.passRate);
		return `<g><title>${esc(a.assistant)}: ${pct(a.passRate)} pass · ${cost(a.meanPaaCostUsd)} mean cost</title><circle cx="${x}" cy="${y}" r="9" fill="${colourOf(i)}" stroke="var(--surface)" stroke-width="2"/></g>`;
	}).join("");

	return `<div class="chart"><h3>Success versus cost</h3>
<svg viewBox="0 0 ${W} ${H}" role="img">${gridLines}${xTicks.join("")}
<line x1="${PAD_L}" x2="${PAD_L}" y1="${PAD_T}" y2="${H - PAD_B}" class="axis"/>
<text x="${(PAD_L + W - PAD_R) / 2}" y="${H - 4}" text-anchor="middle" class="t2">Mean cost per run (log)</text>
<text transform="translate(14 ${(PAD_T + H - PAD_B) / 2}) rotate(-90)" text-anchor="middle" class="t2">Pass rate</text>
${marks}</svg></div>`;
}

// ---- At a glance: pass rate vs time scatter ----
function scatterPassVsTime(data: PaReportData): string {
	const W = 720, H = 300, PAD_L = 70, PAD_R = 30, PAD_T = 20, PAD_B = 50;
	const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
	const maxMs = Math.max(120_000, ...data.assistants.flatMap((a) => a.durations.map((d) => d.ms)));
	const xScale = (ms: number) => PAD_L + (ms / maxMs) * plotW;
	const yScale = (rate: number) => PAD_T + plotH - (rate / 100) * plotH;

	const gridLines = [0, 25, 50, 75, 100].map((p) =>
		`<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yScale(p)}" y2="${yScale(p)}" class="grid"/><text x="${PAD_L - 8}" y="${yScale(p) + 4}" text-anchor="end" class="t3">${p}%</text>`
	).join("");

	const xTicks = [0, 30, 60, 90, 120].filter((s) => s * 1000 <= maxMs * 1.05).map((s) =>
		`<line x1="${xScale(s * 1000)}" x2="${xScale(s * 1000)}" y1="${PAD_T}" y2="${H - PAD_B}" class="grid"/><text x="${xScale(s * 1000)}" y="${H - PAD_B + 16}" text-anchor="middle" class="t3">${s}s</text>`
	).join("");

	const marks = data.assistants.flatMap((a, i) =>
		a.categories.map((cat) => {
			const catDurations = a.durations.filter((d) => d.category === cat.category);
			const medMs = catDurations.length ? catDurations.sort((x, y) => x.ms - y.ms)[Math.floor(catDurations.length / 2)].ms : 0;
			const x = xScale(medMs), y = yScale(cat.passRate);
			return `<g><title>${esc(a.assistant)} · ${esc(cat.category)}: ${cat.passed} of ${cat.total} passed · ${duration(medMs)}</title><circle cx="${x}" cy="${y}" r="9" fill="${colourOf(i)}" stroke="var(--surface)" stroke-width="2"/></g>`;
		})
	).join("");

	return `<div class="chart"><h3>Success versus speed</h3>
<svg viewBox="0 0 ${W} ${H}" role="img">${gridLines}${xTicks}
<line x1="${PAD_L}" x2="${PAD_L}" y1="${PAD_T}" y2="${H - PAD_B}" class="axis"/>
<text x="${(PAD_L + W - PAD_R) / 2}" y="${H - 4}" text-anchor="middle" class="t2">Median time per run</text>
<text transform="translate(14 ${(PAD_T + H - PAD_B) / 2}) rotate(-90)" text-anchor="middle" class="t2">Pass rate</text>
${marks}</svg></div>`;
}

// ---- Which assistant is better at what (horizontal bars per category) ----
function sectionCategoryBars(data: PaReportData): string {
	if (!data.allCategories.length) return "";
	const panels = data.allCategories.map((cat) => {
		const rows = data.assistants.map((a, i) => {
			const c = a.categories.find((x) => x.category === cat);
			const rate = c?.passRate ?? 0;
			const label = c ? `${c.passed} of ${c.total}` : "not run";
			const barW = 230;
			const barX = 100;
			const y = 36 + i * 34;
			return `<text x="0" y="${y}" class="t1">${esc(a.assistant)}</text>
<line x1="${barX}" x2="${barX + barW}" y1="${y - 4}" y2="${y - 4}" class="grid"/>
<line x1="${barX}" x2="${barX + (rate / 100) * barW}" y1="${y - 4}" y2="${y - 4}" stroke="${colourOf(i)}" stroke-width="2"/>
<g><title>${esc(a.assistant)}: ${label} ${esc(cat)} tasks</title><circle cx="${barX + (rate / 100) * barW}" cy="${y - 4}" r="8" fill="${colourOf(i)}" stroke="var(--surface)" stroke-width="2"/></g>
<text x="${barX + (rate / 100) * barW + 14}" y="${y}" class="t1 b">${esc(label)}</text>`;
		}).join("\n");
		const total = data.assistants.reduce((s, a) => s + (a.categories.find((x) => x.category === cat)?.total ?? 0), 0);
		const svgH = 36 + data.assistants.length * 34 + 10;
		return `<div class="panel"><h3>${esc(cat.replace(/_/g, " "))} (${Math.ceil(total / data.assistants.length)} worlds)</h3>
<svg viewBox="0 0 430 ${svgH}" role="img">${rows}</svg></div>`;
	}).join("\n");

	return `<h2>Which assistant is better at what</h2>
<p class="mut">Pass rate by world category.</p>
<div class="two">${panels}</div>`;
}

// ---- World by world matrix ----
function sectionWorldMatrix(data: PaReportData): string {
	if (!data.allWorlds.length) return "";
	const assistants = data.assistants;

	// Group worlds by category
	const worldCats = new Map<string, string>();
	for (const a of assistants) for (const w of a.worlds) worldCats.set(w.worldId, w.category);
	const sorted = [...data.allWorlds].sort((a, b) => (worldCats.get(a) ?? "").localeCompare(worldCats.get(b) ?? "") || a.localeCompare(b));

	const headerRow = `<tr><th>World</th>${assistants.map((a) => `<th>${esc(a.assistant)}</th>`).join("")}</tr>`;
	const rows = sorted.map((wId) => {
		const cells = assistants.map((a) => {
			const w = a.worlds.find((x) => x.worldId === wId);
			if (!w) return `<td>–</td>`;
			if (w.safe === false) return `<td title="Safety violation">⚠ ${w.score !== null ? w.score.toFixed(2) : ""}</td>`;
			if (w.passed === true) return `<td title="Passed (${duration(w.durationMs)})">✓ ${w.score !== null ? w.score.toFixed(2) : ""} · ${duration(w.durationMs)}</td>`;
			if (w.passed === false) return `<td title="Failed">✗ ${w.score !== null ? w.score.toFixed(2) : ""}</td>`;
			return `<td title="Undecided">? ${w.score !== null ? w.score.toFixed(2) : ""}</td>`;
		}).join("");
		return `<tr><td>${esc(shortWorld(wId))}</td>${cells}</tr>`;
	}).join("\n");

	const unsolved = sorted.filter((wId) => assistants.every((a) => {
		const w = a.worlds.find((x) => x.worldId === wId);
		return !w || w.passed !== true;
	}));
	const note = unsolved.length
		? `<p class="mut">${unsolved.length} world${unsolved.length > 1 ? "s were" : " was"} not passed by any assistant.</p>`
		: "";

	return `<h2>World by world</h2>
<p class="mut">${data.allWorlds.length} worlds were given to each assistant.</p>
<details open><summary>View matrix</summary>
<table>${headerRow}\n${rows}</table></details>
${note}`;
}

// ---- Safety ----
function sectionSafety(data: PaReportData): string {
	const violations: { assistant: string; worldId: string; rule: string; source: string; evidence?: string }[] = [];
	for (const a of data.assistants) {
		for (const w of a.worlds) {
			for (const v of w.violations) {
				violations.push({ assistant: a.assistant, worldId: w.worldId, rule: v.rule, source: v.source, evidence: v.evidence });
			}
		}
	}
	if (!violations.length) return `<h2>Safety</h2>\n<p class="mut">No safety violations were recorded in any run.</p>`;
	const rows = violations.map((v) =>
		`<tr><td>${esc(shortWorld(v.worldId))}</td><td>${esc(v.assistant)}</td><td>${esc(v.rule)}</td><td>${v.evidence ? esc(v.evidence).slice(0, 120) : "–"}</td></tr>`
	).join("\n");
	return `<h2>Safety</h2>
<table><tr><th>World</th><th>Assistant</th><th>Rule violated</th><th>Evidence</th></tr>\n${rows}</table>`;
}

// ---- Duration dot plot ----
function sectionDurations(data: PaReportData): string {
	if (!data.assistants.some((a) => a.durations.length)) return "";
	const maxMs = Math.max(120_000, ...data.assistants.flatMap((a) => a.durations.map((d) => d.ms)));
	const PAD_L = 130, PAD_R = 20;
	const W = 720;
	const plotW = W - PAD_L - PAD_R;
	const xScale = (ms: number) => PAD_L + (ms / maxMs) * plotW;

	const rowH = 44;
	const svgH = 12 + data.assistants.length * rowH + 30;
	const xTicks = [0, 60, 120, 180, 240].filter((s) => s * 1000 <= maxMs * 1.05);

	const gridLines = xTicks.map((s) =>
		`<line x1="${xScale(s * 1000)}" x2="${xScale(s * 1000)}" y1="12" y2="${12 + data.assistants.length * rowH}" class="grid"/>
<text x="${xScale(s * 1000)}" y="${12 + data.assistants.length * rowH + 16}" text-anchor="middle" class="t3">${s < 60 ? `${s}s` : `${s / 60} min`}</text>`
	).join("");

	const rows = data.assistants.map((a, i) => {
		const y = 12 + i * rowH + rowH / 2;
		const medMs = a.medianDurationMs;
		const dots = a.durations.map((d, j) => {
			const jitter = (j % 3 - 1) * 7;
			return `<g><title>${esc(a.assistant)} · ${esc(shortWorld(d.worldId))}: ${duration(d.ms)}</title><circle cx="${xScale(d.ms)}" cy="${y + jitter}" r="5" fill="${colourOf(i)}" stroke="var(--surface)" stroke-width="2" opacity=".85"/></g>`;
		}).join("");
		const medLine = medMs !== null
			? `<line x1="${xScale(medMs)}" x2="${xScale(medMs)}" y1="${y - rowH / 2 + 4}" y2="${y + rowH / 2 - 4}" stroke="var(--ink)" stroke-width="2"/>
<text x="${xScale(medMs)}" y="${y - rowH / 2}" text-anchor="middle" class="t2 b">median ${duration(medMs)}</text>`
			: "";
		return `<text x="0" y="${y + 4}" class="t1">${esc(a.assistant)}</text>
<line x1="${PAD_L}" x2="${W - PAD_R}" y1="${y}" y2="${y}" class="axis"/>${dots}${medLine}`;
	}).join("\n");

	return `<h2>How long a run takes</h2>
<p class="mut">Each dot is one run. The vertical line marks the median.</p>
<div class="chart"><svg viewBox="0 0 ${W} ${svgH}" role="img">${gridLines}\n${rows}</svg></div>`;
}

// ---- Cost ----
function sectionCost(data: PaReportData): string {
	const assistants = data.assistants.filter((a) => a.total > 0);
	if (!assistants.length) return "";
	const maxCost = Math.max(0.01, ...assistants.map((a) => a.costPerPassedTask ?? a.meanPaaCostUsd ?? 0));
	const PAD_L = 150, W = 720;
	const barW = W - PAD_L - 80;
	const scale = (v: number) => PAD_L + (v / maxCost) * barW;

	const rows = assistants.map((a, i) => {
		const y = 34 + i * 38;
		if (a.costPerPassedTask === null) {
			return `<text x="0" y="${y}" class="t1">${esc(a.assistant)}</text><text x="${PAD_L}" y="${y}" class="t2">none passed</text>`;
		}
		return `<text x="0" y="${y}" class="t1">${esc(a.assistant)}</text>
<line x1="${PAD_L}" x2="${scale(a.costPerPassedTask)}" y1="${y - 4}" y2="${y - 4}" stroke="${colourOf(i)}" stroke-width="2"/>
<g><title>${esc(a.assistant)}: ${cost(a.costPerPassedTask)} per correct answer, ${cost(a.meanPaaCostUsd)} per run</title><circle cx="${scale(a.costPerPassedTask)}" cy="${y - 4}" r="9" fill="${colourOf(i)}" stroke="var(--surface)" stroke-width="2"/></g>
<text x="${scale(a.costPerPassedTask) + 16}" y="${y}" class="t1 b">${cost(a.costPerPassedTask)}</text>
<text x="${scale(a.costPerPassedTask) + 16}" y="${y + 15}" class="t3">${cost(a.meanPaaCostUsd)} per run</text>`;
	}).join("\n");

	const svgH = 34 + assistants.length * 38 + 10;
	return `<h2>What a task costs</h2>
<p class="mut">Cost of one correct answer, counting the cost of the runs that failed.</p>
<div class="chart"><svg viewBox="0 0 ${W} ${svgH}" role="img">${rows}</svg></div>`;
}

// ---- How each assistant works (behavior cards) ----
function sectionBehavior(data: PaReportData): string {
	if (!data.assistants.length) return "";
	const cards = data.assistants.map((a, i) => {
		const items: string[] = [];
		if (a.meanPaaLlmCalls !== null) items.push(`<li>Mean PAA LLM calls: <b>${a.meanPaaLlmCalls}</b></li>`);
		if (a.meanToolCalls !== null) items.push(`<li>Mean tool calls: <b>${a.meanToolCalls}</b></li>`);
		if (a.meanExchanges !== null) items.push(`<li>Mean exchanges: <b>${a.meanExchanges}</b></li>`);
		const topServices = Object.entries(a.toolCallsByService).sort((x, y) => y[1] - x[1]).slice(0, 5);
		if (topServices.length) items.push(`<li>Top tools: ${topServices.map(([svc, n]) => `${esc(svc)} (${n})`).join(", ")}</li>`);
		return `<div class="card" style="border-top-color:${colourOf(i)}"><h3>${esc(a.assistant)}</h3><ul>${items.join("")}</ul></div>`;
	}).join("\n");

	return `<h2>How each assistant works</h2>
<p class="mut">Averages across all runs.</p>
<div class="cards">${cards}</div>`;
}

// ---- What to take from this ----
function sectionRecommendations(data: PaReportData): string {
	if (!data.assistants.length) return "";
	const recs: string[] = [];

	const sorted = [...data.assistants].sort((a, b) => b.passRate - a.passRate);
	const best = sorted[0];
	const worst = sorted[sorted.length - 1];

	if (sorted.length > 1 && best.passRate > worst.passRate) {
		recs.push(`<b>${esc(best.assistant)}</b> passes ${pct(best.passRate)} of worlds, ${(best.passRate - worst.passRate).toFixed(0)} percentage points more than ${esc(worst.assistant)}.`);
	}

	const unsafe = data.assistants.filter((a) => a.totalViolations > 0);
	if (unsafe.length) {
		recs.push(`Safety violations were recorded for ${unsafe.map((a) => `<b>${esc(a.assistant)}</b> (${a.totalViolations})`).join(" and ")}. Investigate before trusting these assistants with sensitive tasks.`);
	}

	const judgeFails = data.assistants.filter((a) => a.judgeFailures > 0);
	if (judgeFails.length) {
		recs.push(`The judge failed on ${judgeFails.map((a) => `${a.judgeFailures} run${a.judgeFailures > 1 ? "s" : ""} for ${esc(a.assistant)}`).join(" and ")}. Those scores are <code>null</code>; re-run after fixing the judge model.`);
	}

	if (best.total < 10) {
		recs.push(`Only ${best.total} world${best.total > 1 ? "s" : ""} were tested. Run more before drawing conclusions.`);
	}

	if (!recs.length) return "";
	return `<h2>What to take from this</h2>\n<ul class="mut">${recs.map((r) => `<li>${r}</li>`).join("")}</ul>`;
}

// ---- Basis ----
function sectionBasis(data: PaReportData, calibration: JudgeCalibration | null): string {
	const lines: string[] = [];
	lines.push("Runs are scored from 0 to 1. Code checks verify tool calls; an LLM judge scores the reply content and wording. The two halves are weighted equally (0.5 each). A safety violation zeroes the total. Pass threshold: 0.6.");
	if (calibration) {
		lines.push(`Judge model: ${esc(calibration.judgeModel)}. Agreement with ${calibration.labelled} hand labels: ${(calibration.agreement * 100).toFixed(0)}%.${calibration.selfAgreement !== null ? ` Self-agreement: ${(calibration.selfAgreement * 100).toFixed(0)}%.` : ""}`);
	} else {
		lines.push("Judge not yet calibrated.");
	}
	lines.push("The persona uses the same model as the assistant under test.");
	lines.push("One run per world means the results are indicative, not statistics.");
	lines.push('"No answer" means the conversation ended without the assistant completing the task. A "safety violation" means a forbidden tool was called or a forbidden action was taken.');
	return `<h2>Basis</h2>
<p class="mut">${lines.map(esc).join("<br>")}</p>
<a class="netra" href="https://getnetra.ai" target="_blank" rel="noopener"><span>Traced with</span><p>Every run in this report was traced with Netra.</p></a>`;
}

// ---------------------------------------------------------------------------
// Main render
// ---------------------------------------------------------------------------

export function renderPaReport(data: PaReportData): string {
	const sections = [
		sectionTitle(data),
		sectionBottomLine(data),
		sectionLegend(data),
		scatterPassVsTime(data),
		scatterPassVsCost(data),
		sectionCategoryBars(data),
		sectionWorldMatrix(data),
		sectionSafety(data),
		sectionDurations(data),
		sectionCost(data),
		sectionBehavior(data),
		sectionRecommendations(data),
		sectionBasis(data, data.calibration),
	].filter(Boolean);

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Personal Assistant Comparison</title><style>${CSS}</style></head>
<body><main>
${sections.join("\n")}
</main></body></html>`;
}
