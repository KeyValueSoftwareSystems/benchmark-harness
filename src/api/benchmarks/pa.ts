import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { API_CONTAINER_NAME, JUDGE_MODEL, MODELS, RESOURCES_DIR } from "../config.ts";
import { withAgent } from "../docker/agent.ts";
import { AGENT_CONTAINER_PREFIX, docker, PA_JOB_NETWORK_PREFIX, PAA_CONTAINER_PREFIX } from "../docker/cli.ts";
import { DEFAULT_PA_ASSISTANT, isPaAssistant, PAA_CHAT_PORT, PAA_PROFILES, type PaaInfo, type PaAssistant, type ToolCallRecord, WORLD_DIR_IN_CONTAINER } from "../../pa/constants.ts";
import { runChecks } from "../../pa/grading/checks.ts";
import { buildQuestions, type Exchange, JudgeAnswer, JUDGE_TEMPERATURE, type JudgeChat, type JudgeResult, judgeRun, pickTranscript } from "../../pa/grading/judge.ts";
import { loadGrading } from "../../pa/grading/load.ts";
import { loadSelection } from "../../pa/selection.ts";
import { type CallUsage, computeScore, type LlmSideUsage, PASS_THRESHOLD, type PaScore, sideUsage, sumUsage } from "../../pa/grading/score.ts";
import { buildPersonaPrompt, type Persona, type World } from "../../pa/persona-prompt.ts";
import { emitPaTrace } from "../netra/trace.ts";
import { chat, CHAT_APIS } from "../../shared/chat.ts";
import { callCost } from "../../shared/llm-usage.ts";
import type { ResultPayload, RunMetrics } from "../../shared/results.ts";
import { type Job, JobParam } from "../../shared/types.ts";
import { withPaa } from "../docker/paa.ts";
import { jobNetworkAddresses } from "../jobNetworks.ts";
import { listLlmCalls, LlmRole, PROXY_APIS, storeLlmToken, removeLlmToken } from "../routes/llm.ts";
import { keys } from "../queue/store.ts";
import { redis } from "../redis.ts";
import { ModelAccess, type Benchmark, type JobInput, type RunScore } from "./types.ts";

const WORLDS_DIR = path.join(RESOURCES_DIR, "pa", "worlds");
const SELECTIONS_DIR = path.join(RESOURCES_DIR, "pa", "selections");
/** Where agent-side world files land inside the PI agent container. */
const AGENT_WORLD_DIR = WORLD_DIR_IN_CONTAINER;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const worldDir = (id: string) => path.join(WORLDS_DIR, id);
const agentDir = (id: string) => path.join(worldDir(id), "agent");

async function loadWorld(id: string): Promise<World> {
	if (!/^[\w.-]+$/.test(id)) throw new Error(`invalid world id ${id}`);
	const raw = await readFile(path.join(worldDir(id), "world.yaml"), "utf8");
	return YAML.parse(raw) as World;
}

async function loadPersona(id: string): Promise<Persona> {
	return JSON.parse(await readFile(path.join(agentDir(id), "persona.json"), "utf8"));
}

/** The world ids a request names: the worlds of a selection, every world, or one world. */
async function worldIdsFor(world: unknown, selection: unknown): Promise<string[]> {
	if (typeof selection === "string") return (await loadSelection(selection, SELECTIONS_DIR)).tasks.map((task) => task.worldId);
	return world === "all" ? (await readdir(WORLDS_DIR)).sort() : [String(world)];
}

async function jobInputFor(id: string, assistant: PaAssistant): Promise<JobInput | undefined> {
	try {
		const [w, p] = await Promise.all([loadWorld(id), loadPersona(id)]);
		return { prompt: buildPersonaPrompt(p, w), params: { [JobParam.challenge]: id, [JobParam.assistant]: assistant } };
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const JUDGE_TIMEOUT_MS = 180_000;

async function readToolCalls(jobId: string): Promise<ToolCallRecord[] | undefined> {
	const raw = await redis.get(keys.paToolCalls(jobId));
	return raw ? (JSON.parse(raw) as ToolCallRecord[]) : undefined;
}

async function readPaaInfo(jobId: string): Promise<PaaInfo | null> {
	const raw = await redis.get(keys.paInfo(jobId));
	return raw ? (JSON.parse(raw) as PaaInfo) : null;
}

async function readTranscript(jobId: string, result: ResultPayload | undefined): Promise<Exchange[]> {
	const saved = (await redis.lrange(keys.transcript(jobId), 0, -1)).map((line) => JSON.parse(line) as Exchange);
	return pickTranscript(saved, result?.outcome);
}

function judgeFailed(failure: string): JudgeResult {
	return { judgeModel: JUDGE_MODEL, judgeFailed: true, failure, score: null, reasoning: "", items: [] };
}

interface JudgeOutcome {
	judgement: JudgeResult;
	/** Usage of every judge model call, retries included. */
	usage: LlmSideUsage;
}

async function judgeConversation(world: World, input: Parameters<typeof judgeRun>[0]): Promise<JudgeOutcome> {
	const withoutJudgeCall = (judgement: JudgeResult): JudgeOutcome => ({ judgement, usage: sumUsage([]) });
	// Nothing was said, so there is nothing to judge: every wording check is a "no" and the rubric score is 0.
	if (!input.transcript.length) {
		const items = buildQuestions(input.grading).map((q) => ({ ...q, answer: JudgeAnswer.no, evidence: "", quoteFound: false, counted: JudgeAnswer.no }));
		return withoutJudgeCall({ judgeModel: JUDGE_MODEL, judgeFailed: false, score: 0, reasoning: "The assistant never replied, so there was nothing to judge.", items });
	}
	const model = MODELS.find((m) => m.name === JUDGE_MODEL);
	if (!model) return withoutJudgeCall(judgeFailed(JUDGE_MODEL ? `JUDGE_MODEL ${JUDGE_MODEL} is not in MODELS` : "JUDGE_MODEL is not set"));
	if (!CHAT_APIS.has(model.api)) return withoutJudgeCall(judgeFailed(`JUDGE_MODEL api ${model.api} is not supported`));
	console.log(`[pa] judging world ${world.task_id} with ${model.name}`);

	const callUsages: CallUsage[] = [];
	const send: JudgeChat = async (messages) => {
		const reply = await chat(model, messages, { temperature: JUDGE_TEMPERATURE, timeoutMs: JUDGE_TIMEOUT_MS });
		if (reply.usage) callUsages.push({ ...reply.usage, ...callCost(model, reply.usage) });
		return reply.text;
	};
	const judgement = await judgeRun(input, model.name, send);
	return { judgement, usage: sumUsage(callUsages) };
}

/** Grades a settled PA job from its tool-call log, transcript and LLM call log. */
export async function scorePaRun(job: Job, result: ResultPayload | undefined): Promise<RunScore> {
	const id = job.params?.[JobParam.challenge] ?? "";
	const assistant = job.params?.[JobParam.assistant] ?? DEFAULT_PA_ASSISTANT;
	const [world, grading, toolCalls, transcript, llmCalls, assistantInfo] = await Promise.all([
		loadWorld(id),
		loadGrading(worldDir(id)),
		readToolCalls(job.id),
		readTranscript(job.id, result),
		listLlmCalls(redis, job.id),
		readPaaInfo(job.id),
	]);
	if (!toolCalls) console.error(`[pa] job ${job.id}: no tool-call log; tool checks are unknown`);

	const checks = runChecks(grading, toolCalls);
	const { judgement, usage: judgeUsage } = await judgeConversation(world, { taskPrompt: world.prompt.text, grading, transcript, toolCalls });
	const breakdown = computeScore(grading, checks, judgement);

	const byService: Record<string, number> = {};
	for (const call of toolCalls ?? []) byService[call.service] = (byService[call.service] ?? 0) + 1;
	const paa = sideUsage(llmCalls, LlmRole.paa);
	const score: PaScore = {
		total: breakdown.total,
		checksScore: breakdown.checksScore,
		judgeScore: breakdown.judgeScore,
		judgeWeight: breakdown.judgeWeight,
		judgeReasoning: judgement.reasoning,
		judgeModel: judgement.judgeModel,
		judgeFailed: judgement.judgeFailed,
		...(judgement.failure && { judgeFailure: judgement.failure }),
		passThreshold: PASS_THRESHOLD,
		safe: breakdown.safe,
		violations: breakdown.violations,
		components: breakdown.components,
		checks,
		items: judgement.items,
		toolCallCount: toolCalls ? toolCalls.length : null,
		toolCallsByService: toolCalls ? byService : null,
		exchanges: transcript.length,
		category: world.category ?? null,
		llm: { paa, persona: sideUsage(llmCalls, LlmRole.persona), judge: judgeUsage },
		assistantInfo,
	};
	const span = llmCalls.length
		? Math.max(...llmCalls.map((c) => Date.parse(c.startedAt) + c.latencyMs)) - Math.min(...llmCalls.map((c) => Date.parse(c.startedAt)))
		: 0;
	const metrics: RunMetrics = {
		turns: paa.calls,
		durationMs: result?.metrics.durationMs || span,
		inputTokens: paa.inputTokens,
		outputTokens: paa.outputTokens,
		costUsd: paa.costUsd,
		cacheReadTokens: paa.cacheReadTokens,
		cacheWriteTokens: paa.cacheWriteTokens,
	};
	console.log(`[pa] job ${job.id}: total=${breakdown.total} safe=${breakdown.safe} correct=${breakdown.correct}`);

	const sessionId = await emitPaTrace(job, {
		correct: breakdown.correct,
		score,
		toolCalls,
		llmCalls,
		transcript,
		personaOutcome: result?.outcome ?? null,
	});
	if (sessionId) console.log(`[pa] job ${job.id}: Netra trace emitted (session ${sessionId})`);

	return {
		correct: breakdown.correct,
		outcome: { ...(result?.outcome ?? {}), score },
		metrics,
		assistant,
		...(sessionId && { sessionId }),
	};
}

// ---------------------------------------------------------------------------
// Benchmark implementation
// ---------------------------------------------------------------------------

export const pa: Benchmark = {
	name: "pa",
	concurrency: 2,
	modelAccess: ModelAccess.proxy,
	score: scorePaRun,

	async parse({ world, selection, assistant = DEFAULT_PA_ASSISTANT }) {
		const worldGiven = typeof world === "string";
		if (worldGiven === (typeof selection === "string")) return { error: "give exactly one of world or selection" };
		if (!isPaAssistant(assistant)) return { error: `unknown assistant ${String(assistant)} (one of: ${Object.keys(PAA_PROFILES).join(", ")})` };
		const ids = await worldIdsFor(world, selection).catch(() => undefined);
		if (!ids) return { error: `unknown ${typeof selection === "string" ? "selection" : "world"} ${String(selection ?? world)}` };
		const inputs: JobInput[] = [];
		for (const id of ids) {
			const input = await jobInputFor(id, assistant);
			if (!input) return { error: `unknown world ${id}` };
			inputs.push(input);
		}
		return inputs;
	},

	async context(job) {
		const id = job.params?.[JobParam.challenge] ?? "";
		const world = await loadWorld(id);
		return {
			benchmark: "pa",
			world_id: id,
			assistant_endpoint: `http://${PAA_CONTAINER_PREFIX}${job.id}:${PAA_CHAT_PORT}/chat`,
			conversation_id: `conv-${job.id}`,
			max_exchanges: Number(process.env.PAA_MAX_EXCHANGES ?? 20),
			max_replies: Number(process.env.PAA_MAX_REPLIES ?? 50),
			execution_date: world.execution_date,
			task_name: world.task_name,
			// Authorises POST /jobs/:id/exchanges. Served once with the context, so it never enters the container env.
			exchange_token: (await redis.get(keys.agentLlmToken(job.id))) ?? "",
		};
	},

	async run(job, ctx) {
		const id = job.params?.[JobParam.challenge] ?? "";
		const assistant = job.params?.[JobParam.assistant] ?? DEFAULT_PA_ASSISTANT;
		if (!isPaAssistant(assistant)) return { status: "error", error: `unknown assistant ${assistant}` };
		console.log(`[pa] job-${job.id}: starting world ${id} with assistant ${assistant}`);

		const world = await loadWorld(id);

		const model = MODELS.find((m) => m.name === job.model);
		if (!model) return { status: "error", error: `model ${job.model} is not configured` };
		if (!PROXY_APIS.has(model.api)) {
			return { status: "error", error: `model api ${model.api} is not supported by the LLM proxy (use one of: ${[...PROXY_APIS].join(", ")})` };
		}

		// Generate job-scoped LLM proxy tokens.
		// Neither container receives the real model API key.
		const paaToken = randomBytes(24).toString("hex");
		const agentToken = randomBytes(24).toString("hex");
		await storeLlmToken(redis, paaToken, job.id, LlmRole.paa);
		await storeLlmToken(redis, agentToken, job.id, LlmRole.persona);
		// Store the agent token so /register can return it in proxy mode.
		await redis.set(keys.agentLlmToken(job.id), agentToken, "EX", 3600);
		// A re-run starts with fresh logs.
		await redis.del(keys.transcript(job.id), keys.paToolCalls(job.id), keys.paInfo(job.id), keys.llmCallLog(job.id));

		// Create an internal (no-internet) network for this job. The PAA and the
		// pi agent join only this network.
		const jobNet = `${PA_JOB_NETWORK_PREFIX}${job.id}`;
		const apiContainer = API_CONTAINER_NAME;
		let apiAddress = "";

		try {
			await docker("network", "create", "--internal", jobNet);
			// Connect the API container (as `api`, like on the compose network) so both containers reach it.
			await docker("network", "connect", "--alias", "api", jobNet, apiContainer);
			apiAddress = await docker("inspect", "-f", `{{(index .NetworkSettings.Networks "${jobNet}").IPAddress}}`, apiContainer);
			if (!/^[\d.]+$/.test(apiAddress)) throw new Error(`no api address on ${jobNet}: ${apiAddress}`);
			jobNetworkAddresses.add(apiAddress);

			// Start the PAA container first (waits for healthy), then
			// start the Pi agent inside the callback so both are alive.
			return await withPaa(job, ctx, { llmToken: paaToken, network: jobNet, model, profile: PAA_PROFILES[assistant], worldId: id, executionDate: world.execution_date }, async () => {
				return await withAgent(job, ctx, (agent) => agent.run(job.prompt), {
					name: `${AGENT_CONTAINER_PREFIX}${job.id}`,
					network: jobNet,
					files: { from: agentDir(id), to: AGENT_WORLD_DIR },
				});
			});
		} finally {
			jobNetworkAddresses.delete(apiAddress);
			await removeLlmToken(redis, paaToken).catch(() => {});
			await removeLlmToken(redis, agentToken).catch(() => {});
			await redis.del(keys.agentLlmToken(job.id)).catch(() => {});
			// Disconnect the API container, then remove the per-job network.
			await docker("network", "disconnect", jobNet, apiContainer).catch(() => {});
			await docker("network", "rm", jobNet).catch(() => {});
		}
	},
};
