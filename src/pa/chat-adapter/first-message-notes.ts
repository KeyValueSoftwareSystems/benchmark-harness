export interface FirstMessageContext {
	/** The scenario's date; the clock note is left out when empty. */
	executionDate: string;
	/** The assistant's writable state directory, in addition to /tmp. */
	scratchDir: string;
}

const CLOCK_NOTE =
	"[Important: do NOT use the system clock for the current date/time. You MUST call the get_current_datetime tool to get the correct date before doing any work.]";

function sandboxNote(scratchDir: string): string {
	const writablePaths = scratchDir ? `/tmp and ${scratchDir}` : "/tmp";
	return `[Important: you run in a sandbox with no internet access. Only ${writablePaths} can be written to; everything else is read-only. Do your work with the tools you were given: do not install packages or look for tools that are not listed.]`;
}

/** The notes placed before the user's first message to the assistant. */
export function withFirstMessageNotes(message: string, context: FirstMessageContext): string {
	const notes = [context.executionDate ? CLOCK_NOTE : "", sandboxNote(context.scratchDir)].filter(Boolean);
	return `${notes.join("\n")}\n\n${message}`;
}
