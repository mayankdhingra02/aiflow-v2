import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { LatestGitImplementationResultStore } from "../src/latestGitImplementationResult";
import { createExecutionCandidate, validateBrowserReviewExecutionCandidate } from "../src/browserReviewExecution";

test("latest Git result store defensively copies its one volatile entry", () => {
  const store = new LatestGitImplementationResultStore(); const result: any = { runId: randomUUID(), deliveryStatus: "verified", codex: {}, git: { commitShas: ["a"], } };
  store.replace(result); const copy = store.get()!; copy.git.commitShas.push("b"); assert.deepEqual(store.get()!.git.commitShas, ["a"]);
});
test("browser review candidate validates exact Unicode bytes and digest", () => {
  const candidate = createExecutionCandidate({ requestId: randomUUID(), sourceRunId: randomUUID(), envelopeSha256: "a".repeat(64), decisionSha256: "b".repeat(64), reviewedRepository: "Owner/repo", reviewedBranch: "main", reviewedHeadSha: "c".repeat(40), modelRole: "terra", reasoningEffort: "high", codexInstruction: "Fix 🙂\nexactly", reviewedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(), decisionAcknowledgedAt: new Date("2026-01-01T00:00:01.000Z").toISOString() });
  validateBrowserReviewExecutionCandidate(candidate); assert.equal(candidate.instructionUtf8Bytes, Buffer.byteLength(candidate.codexInstruction));
  assert.throws(() => validateBrowserReviewExecutionCandidate({ ...candidate, instructionUtf8Bytes: 0 }));
});
