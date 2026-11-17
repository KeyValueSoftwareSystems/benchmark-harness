export type FixtureRecord = Record<string, any>;

/** Fixture records together with the creates, updates and removals made during a run, so reads reflect the assistant's writes. */
export class RecordStore<T extends FixtureRecord> {
	private readonly loadFixtureRecords: () => T[];
	private readonly idFields: string[];
	private readonly newIdPrefix: string;
	private readonly created: T[] = [];
	private readonly changesById = new Map<string, Partial<T>>();
	private readonly removedIds = new Set<string>();

	/** `idFields[0]` is the field written on created records; the others are also accepted when looking a record up. */
	constructor(loadFixtureRecords: () => T[], idFields: string[], newIdPrefix: string) {
		this.loadFixtureRecords = loadFixtureRecords;
		this.idFields = idFields;
		this.newIdPrefix = newIdPrefix;
	}

	all(): T[] {
		const fixtureRecords = this.loadFixtureRecords()
			.filter((record) => !this.removedIds.has(this.idOf(record)))
			.map((record) => ({ ...record, ...this.changesById.get(this.idOf(record)) }));
		return [...fixtureRecords, ...this.created];
	}

	find(id: string): T | undefined {
		return this.all().find((record) => this.matchesId(record, id));
	}

	create(fields: Partial<T>): T {
		const record = { ...fields, [this.idFields[0]]: `${this.newIdPrefix}-NEW-${this.created.length + 1}` } as T;
		this.created.push(record);
		return record;
	}

	/** Returns the updated record, or undefined when no record has this id. */
	update(id: string, changes: Partial<T>): T | undefined {
		const record = this.find(id);
		if (!record) return undefined;
		const recordId = this.idOf(record);
		const createdRecord = this.created.find((candidate) => this.idOf(candidate) === recordId);
		if (createdRecord) {
			Object.assign(createdRecord, changes);
			return createdRecord;
		}
		this.changesById.set(recordId, { ...this.changesById.get(recordId), ...changes });
		return this.find(id);
	}

	/** Returns whether a record with this id existed. */
	remove(id: string): boolean {
		const record = this.find(id);
		if (!record) return false;
		const recordId = this.idOf(record);
		const createdIndex = this.created.findIndex((candidate) => this.idOf(candidate) === recordId);
		if (createdIndex >= 0) this.created.splice(createdIndex, 1);
		else this.removedIds.add(recordId);
		return true;
	}

	private idOf(record: T): string {
		return String(record[this.idFields[0]]);
	}

	private matchesId(record: T, id: string): boolean {
		return this.idFields.some((field) => record[field] === id);
	}
}
