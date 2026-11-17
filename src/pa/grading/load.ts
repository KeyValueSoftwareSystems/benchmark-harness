import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { type ApprovableAction, type ApprovalAction, actionForTool, APPROVAL_ACTIONS } from "../approvals.ts";

/** How a scoring component or safety rule is checked. */
export const CheckType = {
	toolCalled: "tool_called",
	toolNotCalled: "tool_not_called",
	keywordsPresent: "keywords_present",
} as const;
export type CheckType = (typeof CheckType)[keyof typeof CheckType];

/** Whether a safety rule's tool is banned outright, or allowed once the user has approved the action. */
export const SafetyMode = { never: "never", needsApproval: "needs_approval" } as const;
export type SafetyMode = (typeof SafetyMode)[keyof typeof SafetyMode];

export interface ToolCalledCheck {
	type: typeof CheckType.toolCalled;
	tool_name: string;
	min_calls: number;
	/** Only meaningful on a safety rule. */
	mode: SafetyMode;
	description?: string;
}

export interface ToolNotCalledCheck {
	type: typeof CheckType.toolNotCalled;
	tool_name: string;
	/** Only meaningful on a safety rule. */
	mode: SafetyMode;
	description?: string;
}

/** Every group must be present; any phrase within a group counts. Judged by the LLM judge, not matched in code. */
export interface KeywordsPresentCheck {
	type: typeof CheckType.keywordsPresent;
	keywords: string[][];
	description?: string;
}

export type Check = ToolCalledCheck | ToolNotCalledCheck | KeywordsPresentCheck;

export interface ScoringComponent {
	name: string;
	weight: number;
	check: Check;
}

export interface ExpectedAction {
	service: string;
	action_key: string;
	required: boolean;
}

/** A world's `grading.yaml`. Safety checks are "must not" rules: each describes something that must not happen. */
export interface Grading {
	task_id: string;
	scoring_components: ScoringComponent[];
	safety_checks: Check[];
	expected_actions: ExpectedAction[];
	judge_rubric: string;
	reference_solution: string;
	primary_dimensions: string[];
}

const DEFAULT_MIN_CALLS = 1;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function fail(where: string, problem: string): never {
	throw new Error(`grading: ${where}: ${problem}`);
}

function text(value: unknown, where: string): string {
	if (typeof value !== "string" || !value.trim()) fail(where, "must be a non-empty string");
	return value;
}

function parseMode(raw: Record<string, unknown>, where: string): SafetyMode {
	if (raw.mode === undefined) return SafetyMode.never;
	if (raw.mode !== SafetyMode.never && raw.mode !== SafetyMode.needsApproval) fail(where, `mode must be ${SafetyMode.never} or ${SafetyMode.needsApproval}`);
	return raw.mode;
}

/** `isSafetyRule`: only a safety rule may need approval, and only for a tool the persona can approve. */
function parseCheck(raw: unknown, where: string, isSafetyRule = false): Check {
	if (!isRecord(raw)) fail(where, "must be a mapping with a type");
	const description = typeof raw.description === "string" ? raw.description : undefined;
	const mode = parseMode(raw, where);
	if (mode === SafetyMode.needsApproval) {
		if (!isSafetyRule) fail(where, "only a safety rule can need approval");
		if (raw.type === CheckType.keywordsPresent) fail(where, "a wording rule cannot need approval");
		if (!actionForTool(String(raw.tool_name))) fail(where, `no approvable action covers tool ${String(raw.tool_name)}`);
	}
	switch (raw.type) {
		case CheckType.toolCalled: {
			const min = raw.min_calls ?? DEFAULT_MIN_CALLS;
			if (!Number.isInteger(min) || (min as number) < 1) fail(where, "min_calls must be a positive integer");
			return { type: CheckType.toolCalled, tool_name: text(raw.tool_name, `${where}.tool_name`), min_calls: min as number, mode, description };
		}
		case CheckType.toolNotCalled:
			return { type: CheckType.toolNotCalled, tool_name: text(raw.tool_name, `${where}.tool_name`), mode, description };
		case CheckType.keywordsPresent: {
			const groups = raw.keywords;
			if (!Array.isArray(groups) || !groups.length || !groups.every((g) => isStrings(g) && g.length)) {
				fail(where, "keywords must be a non-empty list of non-empty phrase lists");
			}
			return { type: CheckType.keywordsPresent, keywords: groups as string[][], description };
		}
		default:
			fail(where, `unknown check type ${JSON.stringify(raw.type)}`);
	}
}

/** Parses and validates a `grading.yaml` document. Throws on anything it does not understand. */
export function parseGrading(source: string, where = "grading.yaml"): Grading {
	const doc = YAML.parse(source) as unknown;
	if (!isRecord(doc)) fail(where, "must be a mapping");
	const components = doc.scoring_components;
	if (!Array.isArray(components) || !components.length) fail(where, "scoring_components must be a non-empty list");
	const scoring = components.map((c, i): ScoringComponent => {
		const at = `${where}: scoring_components[${i}]`;
		if (!isRecord(c)) fail(at, "must be a mapping");
		const weight = c.weight;
		if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) fail(at, "weight must be a positive number");
		return { name: text(c.name, `${at}.name`), weight, check: parseCheck(c.check, `${at}.check`) };
	});
	const safety = doc.safety_checks ?? [];
	if (!Array.isArray(safety)) fail(where, "safety_checks must be a list");
	const actions = doc.expected_actions ?? [];
	if (!Array.isArray(actions)) fail(where, "expected_actions must be a list");
	return {
		task_id: text(doc.task_id, `${where}: task_id`),
		scoring_components: scoring,
		safety_checks: safety.map((s, i) => parseCheck(s, `${where}: safety_checks[${i}]`, true)),
		expected_actions: actions.map((a, i): ExpectedAction => {
			const at = `${where}: expected_actions[${i}]`;
			if (!isRecord(a)) fail(at, "must be a mapping");
			return { service: text(a.service, `${at}.service`), action_key: text(a.action_key, `${at}.action_key`), required: a.required === true };
		}),
		judge_rubric: text(doc.judge_rubric, `${where}: judge_rubric`),
		reference_solution: text(doc.reference_solution, `${where}: reference_solution`),
		primary_dimensions: isStrings(doc.primary_dimensions) ? doc.primary_dimensions : [],
	};
}

/** The actions covered by the world's "needs approval" safety rules, in a stable order. */
export function approvableActionsOf(grading: Grading): ApprovableAction[] {
	const actions = new Set<ApprovalAction>();
	for (const rule of grading.safety_checks) {
		if (rule.type === CheckType.keywordsPresent || rule.mode !== SafetyMode.needsApproval) continue;
		const action = actionForTool(rule.tool_name);
		if (action) actions.add(action);
	}
	return [...actions].sort().map((action) => ({ action, label: APPROVAL_ACTIONS[action].label }));
}

export async function loadGrading(worldDir: string): Promise<Grading> {
	const file = path.join(worldDir, "grading.yaml");
	return parseGrading(await readFile(file, "utf8"), file);
}
