import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { BrowserReviewExecutionController, createExecutionCandidate, type BrowserReviewCandidateProvider, type BrowserReviewExecutionCandidate, type BrowserReviewExecutionRecord, validateBrowserReviewExecutionCandidate } from "../src/browserReviewExecution";
import { LatestGitImplementationResultStore } from "../src/latestGitImplementationResult";
import { LatestGitResultBrowserDeliveryController, LatestGitResultBrowserDeliveryError } from "../src/latestGitResultBrowserDelivery";

test("candidate validation rejects every correlation and instruction integrity mutation", () => {
  const candidate = makeCandidate();
  for (const mutation of [
    { requestId: "no" }, { sourceRunId: "no" }, { envelopeSha256: "A".repeat(64) }, { decisionSha256: "b".repeat(63) }, { instructionSha256: "no" },
    { reviewedRepository: "bad" }, { reviewedBranch: "bad\nbranch" }, { reviewedHeadSha: "no" }, { modelRole: "bad" }, { reasoningEffort: "bad" },
    { reviewedAt: "bad" }, { decisionAcknowledgedAt: "bad" }, { codexInstruction: "   " }, { instructionUtf8Bytes: 0 }, { instructionSha256: "0".repeat(64) },
  ]) assert.throws(() => validateBrowserReviewExecutionCandidate({ ...candidate, ...mutation }));
  assert.equal(candidate.codexInstruction, "Fix 🙂\nexactly");
});

test("reviewed execution reserves once, preserves exact instruction, stores and exposes a terminal record", async () => {
  const candidate = makeCandidate(); const provider = new Provider(candidate); const results = new LatestGitImplementationResultStore(); const calls: any[] = [];
  const controller = new BrowserReviewExecutionController(provider, {
    snapshot: async () => ({ repository: candidate.reviewedRepository, branch: candidate.reviewedBranch, baseSha: candidate.reviewedHeadSha }),
    run: async (request: unknown) => { calls.push(request); return result(request as any); },
  } as any, results, ui(true), randomUUID);
  const outcome = await controller.run();
  assert.equal(calls.length, 1); assert.equal(calls[0].prompt, candidate.codexInstruction); assert.equal(calls[0].modelRole, candidate.modelRole);
  assert.equal(provider.getLatestExecutionRecord()?.executionState, "completed"); assert.equal(provider.getLatestExecutionRecord()?.executionRunId, outcome?.runId);
  assert.equal(results.get()?.runId, outcome?.runId); await assert.rejects(controller.run());
});

test("confirmation cancellation preserves candidate executability and records the outcome", async () => {
  const candidate = makeCandidate(); const provider = new Provider(candidate);
  const controller = new BrowserReviewExecutionController(provider, { snapshot: async () => ({ repository: candidate.reviewedRepository, branch: candidate.reviewedBranch, baseSha: candidate.reviewedHeadSha }), run: async () => { throw new Error("must not run"); } } as any, new LatestGitImplementationResultStore(), ui(false), randomUUID);
  assert.equal(await controller.run(), undefined); assert.ok(provider.getExecutionCandidate()); assert.equal(provider.getLatestExecutionRecord()?.executionState, "confirmation_cancelled");
});

test("explicit browser result delivery accepts only a fully correlated acknowledgement and preserves result on failure", async () => {
  const store = new LatestGitImplementationResultStore(); const value = result({ runId: randomUUID() } as any); store.replace(value);
  const envelope = { runId: value.runId, envelopeSha256: "" };
  const ui = { appendOutput: () => undefined, showInformation: () => undefined, showError: () => undefined };
  const good = new LatestGitResultBrowserDeliveryController(store, { sendImplementationReviewEnvelope: async (actual: any) => ({ bridgeMessageId: randomUUID(), runId: actual.runId, envelopeSha256: requireDigest(actual), acknowledgedAt: "2026-01-01T00:00:00.000Z" }) }, ui);
  await good.send();
  const bad = new LatestGitResultBrowserDeliveryController(store, { sendImplementationReviewEnvelope: async () => ({ bridgeMessageId: "bad", runId: envelope.runId, envelopeSha256: "0".repeat(64), acknowledgedAt: "bad" }) }, ui);
  await assert.rejects(bad.send(), (error: unknown) => error instanceof LatestGitResultBrowserDeliveryError && error.code === "ACKNOWLEDGEMENT_MISMATCH");
  assert.equal(store.get()?.runId, value.runId);
});

function makeCandidate(): BrowserReviewExecutionCandidate { return createExecutionCandidate({ requestId: randomUUID(), sourceRunId: randomUUID(), envelopeSha256: "a".repeat(64), decisionSha256: "b".repeat(64), reviewedRepository: "Owner/repository", reviewedBranch: "main", reviewedHeadSha: "c".repeat(40), modelRole: "terra", reasoningEffort: "high", codexInstruction: "Fix 🙂\nexactly", reviewedAt: "2026-01-01T00:00:00.000Z", decisionAcknowledgedAt: "2026-01-01T00:00:01.000Z" }); }
function result(request: any): any { const time = "2026-01-01T00:00:00.000Z"; return { runId: request.runId, deliveryStatus: "verified", codex: { outcome: "completed", finalResponse: "done", requestedModelRole: "terra", requestedModelId: "gpt-5.6-codex", requestedReasoningEffort: "high", recordedModelId: null, recordedReasoningEffort: null, conversationId: randomUUID(), turnId: randomUUID(), startedAt: time, finishedAt: time }, git: { githubRepository: "Owner/repository", branch: "main", baseSha: "c".repeat(40), headSha: "d".repeat(40), commitShas: [], pushVerified: true, workingTreeClean: true, upstreamRemote: "origin", upstreamRef: "origin/main", remoteHeadSha: "d".repeat(40) } }; }
function requireDigest(envelope: any): string { const { reviewEnvelopeSha256 } = require("../src/browserBridgeProtocol"); return reviewEnvelopeSha256(envelope); }
function ui(confirm: boolean): any { return { getOpenCanonicalWorkspace: async () => "/workspace", confirmReviewedChange: async () => confirm, appendOutput: () => undefined, showError: () => undefined }; }
class Provider implements BrowserReviewCandidateProvider {
  private state: any = "available"; private record: BrowserReviewExecutionRecord;
  constructor(private readonly candidate: BrowserReviewExecutionCandidate) { this.record = { ...candidate, repository: candidate.reviewedRepository, branch: candidate.reviewedBranch, candidateState: "available", executionState: "available", resultAvailableForBrowserDelivery: false }; }
  getExecutionCandidate() { return this.state === "available" ? { ...this.candidate } : null; } getExecutionCandidateState() { return this.state; }
  reserveExecutionCandidate() { if (this.state !== "available") return null; this.state = "reserved"; this.record = { ...this.record, candidateState: "reserved", executionState: "reserved" }; return { ...this.candidate }; }
  consumeExecutionCandidate() { if (this.state !== "reserved") return false; this.state = "consumed"; this.record = { ...this.record, candidateState: "consumed" }; return true; }
  getLatestExecutionRecord() { return { ...this.record }; } markExecutionRecord(_key: any, patch: Partial<BrowserReviewExecutionRecord>) { this.record = { ...this.record, ...patch }; }
}
