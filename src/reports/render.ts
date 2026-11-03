import type { ModelMetrics } from "./metrics.ts";

export interface ReportInput {
	title: string;
	benchmark: string;
	challengeCount: number;
	conditions: string;
	models: ModelMetrics[];
	narrative?: string;
}

const esc = (value: unknown) =>
	String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

const duration = (ms: number | null) => (ms === null ? "–" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const cost = (usd: number | null) => (usd === null ? "–" : `$${usd.toFixed(2)}`);
const label = (m: ModelMetrics) => `${m.solved}/${m.total} · ${m.successRate}%`;

const CSS = `
:root{--bg:#fff;--fg:#14161a;--muted:#6b7280;--line:#e6e8eb;--card:#fff;--track:#f3f4f6;--best:#4ca555;--bar:#6b7690}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#f1f3f5;--muted:#9aa3b2;--line:#262a31;--card:#161920;--track:#232731;--bar:#8792ad}}
*{box-sizing:border-box}body{margin:0;padding:32px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:860px;margin:0 auto}.card{border:1px solid var(--line);border-radius:20px;padding:28px;background:var(--card)}
h1{margin:0 0 12px;font-size:26px}.sub{color:var(--muted);margin:0 0 24px}
.row{display:flex;justify-content:space-between;align-items:baseline;margin-top:18px;font-weight:600}.row .v{font-variant-numeric:tabular-nums}
.best .v{color:var(--best)}.track{height:10px;border-radius:6px;background:var(--track);margin-top:8px;overflow:hidden}
.fill{height:100%;border-radius:6px;background:var(--bar)}.best .fill{background:var(--best)}
.note{margin:24px 0 0;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
h2{margin:32px 0 12px;font-size:20px}table{width:100%;border-collapse:collapse}th,td{padding:12px 8px;border-bottom:1px solid var(--line);text-align:right;font-variant-numeric:tabular-nums}
th:first-child,td:first-child{text-align:left}th{font-weight:600}.narrative{white-space:pre-wrap}
@media (max-width:520px){body{padding:16px}.card{padding:18px}th,td{padding:10px 4px;font-size:14px}}`;

/** One self-contained HTML document: title card with bars (best first), then the metrics table and optional narrative. */
export function renderReport(input: ReportInput): string {
	const models = [...input.models].sort((a, b) => b.successRate - a.successRate);
	const bars = models
		.map(
			(m, i) => `<div class="${i === 0 ? "best" : ""}"><div class="row"><span>${esc(m.model)}</span><span class="v">${esc(label(m))}</span></div>
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
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(input.title)}</title><style>${CSS}</style></head>
<body><main>
<section class="card"><h1>${esc(input.title)}</h1>
<p class="sub">${esc(input.challengeCount)} challenges · ${esc(input.conditions)}</p>
${bars}
<p class="note">Primary metric: successful challenges ÷ total valid challenges × 100.</p></section>
<h2>Metrics</h2>
<table><thead><tr><th>Metric</th>${head}</tr></thead><tbody>
${rows}
</tbody></table>${input.narrative ? `\n<h2>Insights</h2>\n<p class="narrative">${esc(input.narrative)}</p>` : ""}
</main></body></html>`;
}
