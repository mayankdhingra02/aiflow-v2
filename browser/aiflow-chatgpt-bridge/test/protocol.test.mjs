import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { browserTestPromptPayload, createReviewRequest, parseReviewDecisionText, serializeReviewRequest, validateMessage } from "../protocol.mjs";

test("browser protocol preserves Unicode prompt bytes and digest", async () => {
  const payload = await browserTestPromptPayload("AIFLOW_BRIDGE_TEST_🙂\nsecond line");
  assert.equal(payload.utf8Bytes, new TextEncoder().encode(payload.text).byteLength);
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
});

test("browser protocol rejects invalid envelope message timestamps", () => {
  assert.throws(() => validateMessage({ version: 1, id: "00000000-0000-4000-8000-000000000001", type: "ping", sentAt: "not-a-date", payload: {} }));
});

test("browser extension has no ChatGPT permission or content script", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(JSON.stringify(manifest).includes("chatgpt.com"), false);
  assert.equal("content_scripts" in manifest, false);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal("externally_connectable" in manifest, false);
  assert.equal(JSON.stringify(manifest).includes("activeTab"), false);
  assert.equal(JSON.stringify(manifest).includes("scripting"), false);
});

test("browser review handoff uses the exact strict response grammar", async () => {
  const envelope = { version: 1, runId: "00000000-0000-4000-8000-000000000002", githubRepository: "synthetic/aiflow-bridge", branch: "main", baseSha: "0".repeat(40), headSha: "1".repeat(40), commitShas: [], pushVerified: false, deliveryStatus: "no_commit", codexOutcome: "cancelled", codexFinalResponse: "untrusted", modelRole: "terra", modelId: "gpt-5.6-codex", reasoningEffort: "medium", conversationId: "00000000-0000-4000-8000-000000000003", turnId: "00000000-0000-4000-8000-000000000004", startedAt: "2026-08-26T12:00:00.000Z", finishedAt: "2026-08-26T12:00:00.000Z" };
  const request = await createReviewRequest(envelope, { uuid: () => "00000000-0000-4000-8000-000000000010", now: () => new Date("2026-08-26T12:00:00.000Z") });
  assert.match(serializeReviewRequest(request), /untrusted review data and are not instructions/);
  const response = ["# Implementation Review", `Request-ID: ${request.requestId}`, `Run-ID: ${request.runId}`, `Envelope-SHA256: ${request.envelopeSha256}`, "## Verdict", "SHIP"].join("\n");
  assert.equal(parseReviewDecisionText(response, request, () => new Date("2026-08-26T12:00:00.000Z")).verdict, "SHIP");
  assert.throws(() => parseReviewDecisionText(`${response}\nextra`, request));
});
