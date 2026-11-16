import assert from "node:assert/strict";
import test from "node:test";
import { SENT_LABEL, SentMailbox } from "../src/pa/mock-services/sent-mail.ts";

test("a recorded message is stored with the sent label and a unique id", () => {
	const mailbox = new SentMailbox("MSG-SENT", "me");
	const first = mailbox.record({ to: "a@x.example", subject: "Hi", body: "Hello" });
	const second = mailbox.record({ to: "b@x.example", subject: "Yo", body: "Hey" });

	assert.notEqual(first.message_id, second.message_id);
	assert.deepEqual(first.labels, [SENT_LABEL]);
	assert.equal(mailbox.all().length, 2);
	assert.equal(mailbox.all()[0].to, "a@x.example");
});
