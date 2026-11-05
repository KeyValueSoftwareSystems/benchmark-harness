// Usage: HF_TOKEN=... node --experimental-strip-types scripts/import-gaia.ts [--count 10] [--force]
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";

const token = process.env.HF_TOKEN;
if (!token) throw new Error("HF_TOKEN is required (GAIA is a gated dataset)");
const args = process.argv.slice(2);
const count = Number(args[args.indexOf("--count") + 1]) || 10;
const force = args.includes("--force");

// Metadata is parquet-only, so read it through the datasets-server rows API.
const url = "https://datasets-server.huggingface.co/rows?dataset=gaia-benchmark/GAIA&config=2023_level1&split=validation&offset=0&length=100";
const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok) throw new Error(`GAIA download failed: ${res.status}`);
const rows = ((await res.json()) as { rows: { row: any }[] }).rows.map((r) => r.row);

// Level 1, no attachment, solved by annotators with a browser/search engine and no video/audio tools.
const tools = (r: any) => String(r["Annotator Metadata"]?.Tools ?? "").toLowerCase();
const picked = rows
	.filter((r) => Number(r.Level) === 1 && !r.file_name && /web browser|search engine/.test(tools(r)) && !/video|audio/.test(tools(r)))
	.slice(0, count);
const out = path.join(import.meta.dirname, "..", "resources", "browser", "tasks");
for (const r of picked) {
	const dir = path.join(out, r.task_id);
	if (!force && (await access(dir).then(() => true, () => false))) { console.log(`skip ${r.task_id}`); continue; }
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "task.json"), JSON.stringify({ name: `GAIA L1 ${r.task_id}`, level: r.Level, prompt: r.Question, answer: r["Final answer"] }, null, "\t") + "\n");
	console.log(`wrote ${r.task_id}`);
}
