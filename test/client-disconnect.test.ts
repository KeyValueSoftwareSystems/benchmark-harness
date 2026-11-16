import assert from "node:assert/strict";
import test from "node:test";
import { isClientDisconnect } from "../src/api/client-disconnect.ts";

const open = { replyStreamEnded: false, clientConnectionClosed: false };

test("a premature close counts as the client leaving only once the reply had finished streaming", () => {
	assert.equal(isClientDisconnect({ code: "ERR_STREAM_PREMATURE_CLOSE" }, { ...open, replyStreamEnded: true }), true);
	assert.equal(isClientDisconnect({ code: "ERR_STREAM_PREMATURE_CLOSE" }, open), false);
});

test("being unable to pipe counts as the client leaving only when the client's connection is closed", () => {
	assert.equal(isClientDisconnect({ code: "ERR_STREAM_UNABLE_TO_PIPE" }, { ...open, clientConnectionClosed: true }), true);
	assert.equal(isClientDisconnect({ code: "ERR_STREAM_UNABLE_TO_PIPE" }, open), false);
});

test("any other error is a real failure", () => {
	assert.equal(isClientDisconnect({ code: "ECONNRESET" }, { replyStreamEnded: true, clientConnectionClosed: true }), false);
	assert.equal(isClientDisconnect({}, { replyStreamEnded: true, clientConnectionClosed: true }), false);
});
