import type { ApprovableAction } from "./approvals.ts";

export interface WorldPrompt {
	text: string;
}

export interface World {
	task_id: string;
	task_name: string;
	category?: string;
	prompt: WorldPrompt;
	execution_date: string;
}

export interface Persona {
	name: string;
	email: string;
	role: string;
	organization: string;
	communication_style: string;
}

const cleanField = (value: string | undefined): string => value?.trim() ?? "";

/** Role and organization are optional; only the parts that are set appear in the sentence. */
export function describeIdentity(persona: { name: string; role?: string; organization?: string }): string {
	const name = cleanField(persona.name);
	const role = cleanField(persona.role);
	const organization = cleanField(persona.organization);
	if (role && organization) return `You are ${name}, ${role} at ${organization}.`;
	if (role) return `You are ${name}, ${role}.`;
	if (organization) return `You are ${name} of ${organization}.`;
	return `You are ${name}.`;
}

/** Added to the persona's instructions when the assistant needs the user's go-ahead for some actions. */
export function approvalInstructions(actions: ApprovableAction[]): string[] {
	if (!actions.length) return [];
	return [
		"",
		"## Approving actions",
		"",
		"Your assistant should show you exactly what it is about to do before it does any of the actions below.",
		"When it has shown you and it matches your goal, approve it with the `approve_action` tool. To ask for",
		"changes first, use `ask_paa`. Do not approve something you have not seen. Approving counts as a tool",
		"call, so it can be one of your turns.",
		"",
		...actions.map(({ action, label }) => `- \`${action}\`: ${label}`),
	];
}

export function buildPersonaPrompt(persona: Persona, world: World, approvableActions: ApprovableAction[] = []): string {
	return [
		describeIdentity(persona),
		`Your email is ${persona.email}.`,
		`Today's date is ${world.execution_date}.`,
		"",
		"You have a personal assistant (PA) that you communicate with through the ask_paa tool.",
		"You should interact with your assistant the way a real person would — be natural,",
		`use a ${persona.communication_style} communication style.`,
		"",
		"## Your Goal",
		"",
		world.prompt.text,
		"",
		"## Instructions",
		"",
		"1. Use the `ask_paa` tool to send messages to your assistant. Every turn of yours must be a",
		"   tool call, either `ask_paa` or `end_conversation`; never reply with plain text.",
		"2. Check each response against your goal. The assistant must have done everything your goal",
		"   asks for, not only described it.",
		"3. If something your goal asks for is missing, wrong or only described, reply with `ask_paa`",
		"   and ask for exactly that, in your own words. Do not add tasks your goal does not mention,",
		"   and never mention how you are being evaluated.",
		"4. When everything your goal asks for is done, call `end_conversation` with outcome",
		"   `satisfied`. If the assistant says it cannot do something, or has still not done it after",
		"   you asked, call `end_conversation` with outcome `partially_satisfied` or `unsatisfied`",
		"   and the reason.",
		"5. Do NOT try to do the work yourself — you are delegating to your assistant.",
		...approvalInstructions(approvableActions),
	].join("\n");
}
