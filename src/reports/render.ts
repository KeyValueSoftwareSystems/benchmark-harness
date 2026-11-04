import type { ModelMetrics } from "./metrics.ts";
import type { NetraSummary } from "./netra.ts";

export interface ReportInput {
	title: string;
	benchmark: string;
	challengeCount: number;
	conditions: string;
	models: ModelMetrics[];
	/** Netra insights per model; the section is left out when no model has any. */
	netra?: NetraSummary[];
	narrative?: string;
}

const esc = (value: unknown) =>
	String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const duration = (ms: number | null) => (ms === null ? "–" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const cost = (usd: number | null) => (usd === null ? "–" : `$${usd.toFixed(2)}`);
const seconds = (ms: number | null) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const count = (n: number | null) => (n === null ? "–" : Math.round(n).toLocaleString("en-US"));
const label = (m: ModelMetrics) => `${m.solved}/${m.total} · ${m.successRate}%`;

const CSS = `
:root{--bg:#fff;--fg:#14161a;--muted:#6b7280;--line:#e6e8eb;--card:#fff;--track:#f3f4f6;--best:#4ca555;--bar:#6b7690}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#f1f3f5;--muted:#9aa3b2;--line:#262a31;--card:#161920;--track:#232731;--bar:#8792ad}}
*{box-sizing:border-box}body{margin:0;padding:40px 16px;background:var(--bg);color:var(--fg);font:17px/1.5 Inter,-apple-system,"Segoe UI","Helvetica Neue",Arial,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:860px;margin:0 auto}.card{border:1px solid var(--line);border-radius:22px;padding:28px 28px 26px;background:var(--card)}
h1{margin:0 0 14px;font-size:27px;line-height:1.2;font-weight:700;letter-spacing:-.01em}.sub{color:var(--muted);margin:0 0 26px;font-size:16px}
.row{display:flex;justify-content:space-between;align-items:baseline;margin-top:26px;font-size:20px;font-weight:600}.row .v{font-variant-numeric:tabular-nums;font-weight:700}
.best .v{color:var(--best)}.track{height:11px;border-radius:6px;background:var(--track);margin-top:10px;overflow:hidden}
.fill{height:100%;border-radius:6px;background:var(--bar)}.best .fill{background:var(--best)}
.note{margin:28px 0 0;padding-top:22px;border-top:1px solid var(--line);color:var(--muted);font-size:16px}
.lead{margin:34px 0 18px;font-size:19px}h2{margin:34px 0 12px;font-size:20px}
table{width:100%;border-collapse:collapse;font-size:17px}th,td{padding:16px 8px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
th:first-child,td:first-child{text-align:left}th{font-weight:700}.narrative{white-space:pre-wrap}
@media (max-width:560px){body{padding:16px}.card{padding:18px}h1{font-size:22px}.row{font-size:17px}th,td{padding:12px 4px;font-size:14px}}`;

/** One self-contained HTML document: title card with bars (best first), then the metrics table and optional narrative. */
export function renderReport(input: ReportInput): string {
	const models = [...input.models].sort((a, b) => b.successRate - a.successRate);
	const netraOf = (m: ModelMetrics) => input.netra?.find((n) => n.model === m.model);
	const bars = models
		.map(
			(m, i) => `<div class="${i === 0 ? "best" : ""}"><div class="row"><span>${esc(m.model)}</span><span class="v">${esc(label(m))}${m.total < input.challengeCount ? " (partial)" : ""}</span></div>
<div class="track"><div class="fill" style="width:${Math.min(100, Math.max(0, m.successRate))}%"></div></div></div>`,
		)
		.join("\n");
	const head = models.map((m) => `<th>${esc(m.model)}</th>`).join("");
	const line = (name: string, cells: string[]) => `<tr><td>${name}</td>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
	const rows = [
		line("Challenges solved", models.map((m) => `${m.solved}/${m.total}`)),
		line("Success rate", models.map((m) => `${m.successRate}%`)),
		line("Median solve time", models.map((m) => duration(m.medianSolveMs))),
		line("Average cost per task", models.map((m) => cost(m.avgCostUsd))),
		line("Repeat-run reliability", models.map(() => "To measure")),
	].join("\n");
	const netraRows = (input.netra ?? []).length
		? [
				line("Traced runs", models.map((m) => netraOf(m)?.traces.toString() ?? "–")),
				line("Avg latency", models.map((m) => seconds(netraOf(m)?.avgLatencyMs ?? null))),
				line("Avg tokens (in / out)", models.map((m) => (netraOf(m) ? `${count(netraOf(m)?.avgInputTokens ?? null)} / ${count(netraOf(m)?.avgOutputTokens ?? null)}` : "–"))),
				line("Traces with errors", models.map((m) => (netraOf(m) ? `${netraOf(m)?.errorTraces} of ${netraOf(m)?.traces}` : "–"))),
			].join("\n")
		: "";
	const netraSection = netraRows
		? `\n<p class="lead">Netra insights from the traced runs:</p>\n<table><thead><tr><th>Metric</th>${head}</tr></thead><tbody>\n${netraRows}\n</tbody></table>`
		: "";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title><style>${CSS}</style></head>
<body><main>
<section class="card"><h1>${esc(input.title)}</h1>
<p class="sub">${esc(input.challengeCount)} challenges · ${esc(input.conditions)}</p>
${bars}
<p class="note">Primary metric: successful challenges ÷ total valid challenges × 100.</p></section>
<p class="lead">That gives you the ranking. A useful benchmark report contains more than a single score:</p>
<table><thead><tr><th>Metric</th>${head}</tr></thead><tbody>
${rows}
</tbody></table>${netraSection}${input.narrative ? `\n<h2>Insights</h2>\n<p class="narrative">${esc(input.narrative)}</p>` : ""}
</main></body></html>`;
}
