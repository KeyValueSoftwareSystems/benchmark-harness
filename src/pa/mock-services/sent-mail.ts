export const SENT_LABEL = "SENT";

export interface SentMessage {
	message_id: string;
	from: string;
	to: string;
	subject: string;
	date: string;
	body: string;
	labels: string[];
	is_read: boolean;
}

interface SendRequestBody {
	to?: unknown;
	subject?: unknown;
	body?: unknown;
}

/** Messages the assistant sent during a run, so listing and reading show them like any other mail. */
export class SentMailbox {
	private readonly messages: SentMessage[] = [];
	private readonly idPrefix: string;
	private readonly ownerAddress: string;

	constructor(idPrefix: string, ownerAddress: string) {
		this.idPrefix = idPrefix;
		this.ownerAddress = ownerAddress;
	}

	record(request: SendRequestBody): SentMessage {
		const message: SentMessage = {
			message_id: `${this.idPrefix}-${this.messages.length + 1}`,
			from: this.ownerAddress,
			to: String(request.to ?? ""),
			subject: String(request.subject ?? ""),
			date: new Date().toISOString(),
			body: String(request.body ?? ""),
			labels: [SENT_LABEL],
			is_read: true,
		};
		this.messages.push(message);
		return message;
	}

	all(): SentMessage[] {
		return this.messages;
	}
}
