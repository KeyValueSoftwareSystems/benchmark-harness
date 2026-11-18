/**
 * Judge calibration script.
 *
 * 1. Agreement with hand labels: compares stored judge answers against
 *    human labels in resources/pa/judge-labels.json.
 * 2. Self-agreement (optional, --rerun): re-judges a sample of runs and
 *    compares the new answers with the stored ones. This spends credits.
 *
 * Output: resources/pa/judge-calibration.json
 *
 * Usage:
 *   node --experimental-strip-types scripts/pa/calibrate-judge.ts \
 *     --results /data/results --resources ./resources [--rerun]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HandLabel {
	jobId: string;
	item: string;
	answer: "yes" | "no";
}

interface StoredItem {
	item: string;
	answer: "yes" | "no";
	evidence?: string;
}

interface JudgeCalibration {
	judgeModel: string;
	labelled: number;
	agreement: number;
	selfAgreement: number | null;
	date: string;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const { values } = parseArgs({
	options: {
		results: { type: "string", default: "/data/results" },
		resources: { type: "string", default: "./resources" },
		rerun: { type: "boolean", default: false },
	},
});

const resourcesDir = values.resources!;
const resultsDir = values.results!;

// ---------------------------------------------------------------------------
// Step 1: Load hand labels
// ---------------------------------------------------------------------------

const labelsPath = path.join(resourcesDir, "pa", "judge-labels.json");
let labels: HandLabel[];
try {
	labels = JSON.parse(await readFile(labelsPath, "utf8")) as HandLabel[];
} catch (err) {
	console.error(`Cannot read hand labels from ${labelsPath}: ${err instanceof Error ? err.message : err}`);
	console.error("Create resources/pa/judge-labels.json with at least 10 items: [{ jobId, item, answer }]");
	process.exit(1);
}

if (labels.length < 10) {
	console.error(`Only ${labels.length} hand labels found; need at least 10 for meaningful calibration.`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 2: Load model file and find stored judge answers
// ---------------------------------------------------------------------------

// Read all PA model files to find the jobs
const paDir = path.join(resultsDir, "pa");
let modelFiles: string[];
try {
	const { readdir } = await import("node:fs/promises");
	modelFiles = (await readdir(paDir)).filter((f) => f.endsWith(".json"));
} catch {
	console.error(`No PA results found in ${paDir}`);
	process.exit(1);
}

// Build a map of jobId -> stored items
const storedByJob = new Map<string, StoredItem[]>();
let judgeModel = "unknown";

for (const mf of modelFiles) {
	const raw = JSON.parse(await readFile(path.join(paDir, mf), "utf8"));
	for (const run of raw.runs ?? []) {
		const score = run.outcome?.score;
		if (!score?.items) continue;
		storedByJob.set(run.jobId, score.items as StoredItem[]);
		if (score.judgeModel) judgeModel = score.judgeModel;
	}
}

// ---------------------------------------------------------------------------
// Step 3: Compute agreement with hand labels
// ---------------------------------------------------------------------------

let matches = 0;
let compared = 0;

for (const label of labels) {
	const items = storedByJob.get(label.jobId);
	if (!items) {
		console.error(`Warning: no stored items for job ${label.jobId}`);
		continue;
	}
	const stored = items.find((i) => i.item === label.item);
	if (!stored) {
		console.error(`Warning: item "${label.item}" not found in job ${label.jobId}`);
		continue;
	}
	compared++;
	if (stored.answer === label.answer) matches++;
}

if (compared === 0) {
	console.error("No labels could be compared with stored answers. Check jobIds and item names.");
	process.exit(1);
}

const agreement = matches / compared;
console.log(`Agreement with ${compared} hand labels: ${(agreement * 100).toFixed(1)}% (${matches}/${compared})`);

if (agreement < 0.8) {
	console.error(`\nAgreement ${(agreement * 100).toFixed(0)}% is below 80%. Do NOT publish scores.`);
	console.error("Review the disagreeing items below:");
	for (const label of labels) {
		const items = storedByJob.get(label.jobId);
		const stored = items?.find((i) => i.item === label.item);
		if (stored && stored.answer !== label.answer) {
			console.error(`  ${label.jobId} / ${label.item}: hand=${label.answer} judge=${stored.answer}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Step 4: Self-agreement (optional)
// ---------------------------------------------------------------------------

let selfAgreement: number | null = null;

if (values.rerun) {
	console.log("\n--rerun is set but self-agreement re-judging is not yet implemented.");
	console.log("It requires calling the judge model again, which spends credits.");
	console.log("Implement this after live runs are available and the lead approves.");
	selfAgreement = null;
}

// ---------------------------------------------------------------------------
// Step 5: Write calibration output
// ---------------------------------------------------------------------------

const calibration: JudgeCalibration = {
	judgeModel,
	labelled: compared,
	agreement,
	selfAgreement,
	date: new Date().toISOString().slice(0, 10),
};

const outPath = path.join(resourcesDir, "pa", "judge-calibration.json");
await writeFile(outPath, JSON.stringify(calibration, null, 2) + "\n");
console.log(`\nWrote ${outPath}`);
console.log(JSON.stringify(calibration, null, 2));
