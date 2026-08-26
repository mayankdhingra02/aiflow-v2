import assert from "node:assert/strict";
import { test } from "node:test";

import { createReviewPopupActions, runtimeMessage, sanitizePopupState, validateReviewDecisionAcknowledgement, validateReviewRequestText } from "../popupRuntime.mjs";

const ACK = {
  requestId: "00000000-0000-4000-8000-000000000010",
  runId: "00000000-0000-4000-8000-000000000011",
  envelopeSha256: "a".repeat(64),
  verdict: "SHIP",
  decisionSha256: "b".repeat(64),
  acknowledgedAt: "2026-08-26T12:00:00.000Z",
};

test("runtime error envelopes throw rather than being treated as successful popup responses", async () => {
  await assert.rejects(runtimeMessage(async () => ({ error: "invalid response" }), { action: "createReviewRequest" }), /invalid response/);
  assert.throws(() => validateReviewRequestText(""));
  assert.throws(() => validateReviewDecisionAcknowledgement({ ...ACK, verdict: "NOPE" }));
  assert.throws(() => sanitizePopupState({ authenticated: true, browserToken: "secret" }));
});

test("failed review copy never writes an error object to the clipboard", async () => {
  let clipboardWrites = 0;
  let status = "";
  const actions = createReviewPopupActions({
    sendMessage: async () => ({ error: "review request rejected" }),
    writeClipboard: async () => { clipboardWrites += 1; },
    getPastedResponse: () => "",
    clearPastedResponse: () => undefined,
    setStatus: (value) => { status = value; },
  });
  assert.equal(await actions.copyReviewRequest(), null);
  assert.equal(clipboardWrites, 0);
  assert.match(status, /review request rejected/);
});

test("rejected or malformed review acknowledgements preserve pasted text, while a valid one clears it once", async () => {
  let pasted = "# Implementation Review\nkeep exact";
  let clears = 0;
  let status = "";
  const makeActions = (response) => createReviewPopupActions({
    sendMessage: async () => response,
    writeClipboard: async () => undefined,
    getPastedResponse: () => pasted,
    clearPastedResponse: () => { clears += 1; pasted = ""; },
    setStatus: (value) => { status = value; },
  });
  assert.equal(await makeActions({ error: "decision rejected" }).sendReviewDecision(), null);
  assert.equal(pasted, "# Implementation Review\nkeep exact");
  assert.equal(clears, 0);
  assert.match(status, /decision rejected/);
  assert.equal(await makeActions({ requestId: ACK.requestId }).sendReviewDecision(), null);
  assert.equal(pasted, "# Implementation Review\nkeep exact");
  assert.equal(clears, 0);
  const accepted = await makeActions(ACK).sendReviewDecision();
  assert.equal(accepted?.verdict, "SHIP");
  assert.equal(pasted, "");
  assert.equal(clears, 1);
  assert.match(status, /Accepted SHIP/);
  assert.equal(status.includes("undefined"), false);
});
