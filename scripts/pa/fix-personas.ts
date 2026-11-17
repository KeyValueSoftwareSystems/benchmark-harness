#!/usr/bin/env node
/**
 * Fix persona.json for converted worlds by extracting identity from fixtures.
 *
 * For each world under resources/pa/worlds/, reads gmail/inbox.json to find
 * the primary "to" email (the persona), then looks in contacts/contacts.json
 * for matching name/role/org info.
 *
 * Usage:
 *   node --experimental-strip-types scripts/pa/fix-personas.ts [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import path from "path";

const WORLDS = path.resolve("resources/pa/worlds");
const dryRun = process.argv.includes("--dry-run");

interface Email {
	from: string;
	to: string;
	subject?: string;
	[k: string]: unknown;
}

interface Contact {
	name?: string;
	email?: string;
	company?: string;
	title?: string;
	role?: string;
	organization?: string;
	is_self?: boolean;
	[k: string]: unknown;
}

interface PersonaJson {
	persona_id: string;
	name: string;
	email: string;
	role: string;
	organization: string;
	communication_style: string;
	domain_knowledge: string[];
	execution_date: string;
}

function emailToName(email: string): string {
	const local = email.split("@")[0];
	return local
		.replace(/[._]/g, " ")
		.split(" ")
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function emailToDomain(email: string): string {
	const domain = email.split("@")[1] || "";
	return domain.split(".")[0]
		.replace(/[_-]/g, " ")
		.split(" ")
		.map(w => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

function findPrimaryEmail(emails: Email[]): string | null {
	const toCounts = new Map<string, number>();
	for (const e of emails) {
		const to = (e.to || "").split(",")[0].trim().toLowerCase();
		if (to && to.includes("@")) {
			toCounts.set(to, (toCounts.get(to) || 0) + 1);
		}
	}
	if (toCounts.size === 0) return null;
	return [...toCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function findSelfContact(contacts: Contact[], primaryEmail: string | null): Contact | null {
	for (const c of contacts) {
		if (c.is_self) return c;
	}
	if (primaryEmail) {
		for (const c of contacts) {
			if ((c.email || "").toLowerCase() === primaryEmail) return c;
		}
	}
	return null;
}

let updated = 0;
let skipped = 0;

for (const worldId of readdirSync(WORLDS).sort()) {
	const personaPath = path.join(WORLDS, worldId, "agent", "persona.json");
	if (!existsSync(personaPath)) continue;

	const persona: PersonaJson = JSON.parse(readFileSync(personaPath, "utf8"));

	// Skip worlds that already have non-default persona info
	if (persona.name !== "Alex Morgan" && persona.name !== "") {
		// Check if it's one of the pre-existing worlds
		if (persona.organization !== "Acme Corp") {
			skipped++;
			continue;
		}
	}

	// Read gmail inbox
	const inboxPath = path.join(WORLDS, worldId, "agent", "fixtures", "gmail", "inbox.json");
	let primaryEmail: string | null = null;
	if (existsSync(inboxPath)) {
		const emails: Email[] = JSON.parse(readFileSync(inboxPath, "utf8"));
		primaryEmail = findPrimaryEmail(emails);
	}

	// Read contacts
	const contactsPath = path.join(WORLDS, worldId, "agent", "fixtures", "contacts", "contacts.json");
	let selfContact: Contact | null = null;
	if (existsSync(contactsPath)) {
		const contacts: Contact[] = JSON.parse(readFileSync(contactsPath, "utf8"));
		selfContact = findSelfContact(contacts, primaryEmail);
	}

	if (!primaryEmail && !selfContact) {
		console.error(`[fix-persona] SKIP ${worldId} — no email/contact data found`);
		skipped++;
		continue;
	}

	const email = selfContact?.email || primaryEmail || persona.email;
	const name = selfContact?.name || emailToName(email);
	const role = selfContact?.title || selfContact?.role || "";
	const org = selfContact?.company || selfContact?.organization || emailToDomain(email);

	const newPersona: PersonaJson = {
		...persona,
		name,
		email,
		role,
		organization: org,
	};

	if (dryRun) {
		console.error(`[fix-persona] DRY-RUN ${worldId}: ${name} <${email}> @ ${org}`);
	} else {
		writeFileSync(personaPath, JSON.stringify(newPersona, null, "\t") + "\n");
		console.error(`[fix-persona] UPDATED ${worldId}: ${name} <${email}> @ ${org}`);
	}
	updated++;
}

console.error(`\n[fix-persona] Done: ${updated} updated, ${skipped} skipped`);
