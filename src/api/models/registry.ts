import type { ModelConfig } from "../../shared/types.ts";
import { MODELS } from "../config.ts";

export interface Registry {
	/** Configured models first, then models added from the UI this session. */
	list(): ModelConfig[];
	find(name: string): ModelConfig | undefined;
	isSession(name: string): boolean;
	add(model: ModelConfig): "ok" | "clash";
	/** Session models only. */
	remove(name: string): boolean;
	/** Session models only. */
	setKey(name: string, apiKey: string): boolean;
	/** A session model that has no key right now (never persisted, so lost when the API restarts). */
	needsKey(name: string): boolean;
}

/**
 * Models from `MODELS` plus ones added through the UI. Session models, and their keys, live in this process's memory
 * only: nothing here is written to disk, Redis or SQLite.
 */
export function createRegistry(statics: ModelConfig[]): Registry {
	const session = new Map<string, ModelConfig>();
	const find = (name: string) => statics.find((m) => m.name === name) ?? session.get(name);
	return {
		list: () => [...statics, ...session.values()],
		find,
		isSession: (name) => session.has(name),
		add(model) {
			if (find(model.name)) return "clash";
			session.set(model.name, { ...model });
			return "ok";
		},
		remove: (name) => session.delete(name),
		setKey(name, apiKey) {
			const current = session.get(name);
			if (!current) return false;
			session.set(name, { ...current, apiKey });
			return true;
		},
		needsKey: (name) => session.get(name)?.apiKey === "",
	};
}

/** Why a job on this model cannot start, if it cannot: a session model that lost its key. */
export const keyError = (registry: Registry, name: string): string | undefined => (registry.needsKey(name) ? "needs key again" : undefined);

export const registry = createRegistry(MODELS);
