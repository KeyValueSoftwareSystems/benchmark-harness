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

export function buildPersonaPrompt(persona: Persona, world: World): string {
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
		"1. Use the `ask_paa` tool to send messages to your assistant.",
		"2. Evaluate the assistant's response. If it directly answers your request, call",
		"   `end_conversation` immediately — do NOT add follow-up tasks, request drafts,",
		"   or expand the scope beyond what you originally asked.",
		"3. Only ask follow-up questions if the response is factually wrong, missing key",
		"   information you explicitly asked for, or clearly incomplete.",
		"4. When you are satisfied (or determine the assistant cannot complete the task),",
		"   call `end_conversation` with the outcome and reason.",
		"5. Do NOT try to do the work yourself — you are delegating to your assistant.",
		"6. Stay focused: once your original question is answered, end the conversation.",
		"   Do not request additional work like drafting replies, checking other folders,",
		"   or expanding into tasks you did not originally ask about.",
	].join("\n");
}
