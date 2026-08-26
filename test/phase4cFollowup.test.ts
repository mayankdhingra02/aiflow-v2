import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { LatestGitImplementationResultStore } from "../src/latestGitImplementationResult";
import { createExecutionCandidate, isGitResultDeliverable, validateBrowserReviewExecutionCandidate, validateBrowserReviewExecutionRecord } from "../src/browserReviewExecution";

test("latest Git result store defensively copies its one volatile entry", () => {
  const store = new LatestGitImplementationResultStore(); const result: any = { runId: randomUUID(), deliveryStatus: "verified", codex: {}, git: { commitShas: ["a"], } };
  store.replace(result); const copy = store.get()!; copy.git.commitShas.push("b"); assert.deepEqual(store.get()!.git.commitShas, ["a"]);
});
test("browser review candidate validates exact Unicode bytes and digest", () => {
  const candidate = createExecutionCandidate({ requestId: randomUUID(), sourceRunId: randomUUID(), envelopeSha256: "a".repeat(64), decisionSha256: "b".repeat(64), reviewedRepository: "Owner/repo", reviewedBranch: "main", reviewedHeadSha: "c".repeat(40), modelRole: "terra", reasoningEffort: "high", codexInstruction: "Fix 🙂\nexactly", reviewedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(), decisionAcknowledgedAt: new Date("2026-01-01T00:00:01.000Z").toISOString() });
  validateBrowserReviewExecutionCandidate(candidate); assert.equal(candidate.instructionUtf8Bytes, Buffer.byteLength(candidate.codexInstruction));
  assert.throws(() => validateBrowserReviewExecutionCandidate({ ...candidate, instructionUtf8Bytes: 0 }));
});

for (const [name, patch] of [
  ["record rejects repository drift", { repository: "Other/repo" }], ["record rejects branch drift", { branch: "other" }],
  ["record rejects invalid candidate state", { candidateState: "bad" }], ["record rejects invalid execution state", { executionState: "bad" }],
  ["record rejects invalid correlation state", { reviewCorrelationState: "bad" }], ["record rejects invalid execution ID", { executionRunId: "bad" }],
  ["record rejects invalid timestamp", { startedAt: "bad" }], ["record rejects invalid result head", { resultHeadSha: "bad" }],
  ["record rejects unbounded failure", { failureMessage: "x".repeat(301) }], ["record requires boolean availability", { resultAvailableForBrowserDelivery: "yes" }],
] as const) test(name, () => {
  const candidate = createExecutionCandidate({ requestId: randomUUID(), sourceRunId: randomUUID(), envelopeSha256: "a".repeat(64), decisionSha256: "b".repeat(64), reviewedRepository: "Owner/repo", reviewedBranch: "main", reviewedHeadSha: "c".repeat(40), modelRole: "terra", reasoningEffort: "high", codexInstruction: "Fix 🙂\nexactly", reviewedAt: "2026-01-01T00:00:00.000Z", decisionAcknowledgedAt: "2026-01-01T00:00:01.000Z" });
  const record: any = { ...candidate, repository: candidate.reviewedRepository, branch: candidate.reviewedBranch, candidateState: "available", executionState: "available", resultAvailableForBrowserDelivery: false, reviewCorrelationState: "current" };
  assert.throws(() => validateBrowserReviewExecutionRecord({ ...record, ...patch }));
});

test("invalid or incomplete Git results are not browser-deliverable", () => {
  assert.equal(isGitResultDeliverable(null), false);
  assert.equal(isGitResultDeliverable({ runId: randomUUID(), deliveryStatus: "git_inspection_failed", codex: {}, git: {} } as any), false);
});
