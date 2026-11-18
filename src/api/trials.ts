import { JobParam } from "../shared/types.ts";

/** Most trials one `POST /jobs` item may ask for, per model. */
export const MAX_TRIALS = 10;
const DEFAULT_TRIALS = 1;
export const FIRST_TRIAL = 1;

/** Reads the `trials` field of a `POST /jobs` body; anything but an integer from 1 to `MAX_TRIALS` is an error. */
export function parseTrials(value: unknown): number | { error: string } {
	if (value === undefined) return DEFAULT_TRIALS;
	if (typeof value === "number" && Number.isInteger(value) && value >= FIRST_TRIAL && value <= MAX_TRIALS) return value;
	return { error: `trials must be an integer from 1 to ${MAX_TRIALS}` };
}

/** The params of trial `trial` of a job: the trial number is always recorded, even for a single trial. */
export function withTrial(params: Record<string, string> | undefined, trial: number): Record<string, string> {
	return { ...params, [JobParam.trial]: String(trial) };
}

/** The trial a job belongs to; a missing or invalid value counts as the first trial. */
export function trialOf(params: Record<string, string> | undefined): number {
	const trial = Number(params?.[JobParam.trial] ?? FIRST_TRIAL);
	return Number.isInteger(trial) && trial >= FIRST_TRIAL ? trial : FIRST_TRIAL;
}
