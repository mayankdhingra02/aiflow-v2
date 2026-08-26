import { createHash } from "node:crypto";

import { createImplementationReviewEnvelope, repositoryIdentityEquals, serializeImplementationReviewEnvelope, validateImplementationReviewEnvelope, type GitDeliveryStatus, type GitImplementationRunResult } from "./gitImplementationContracts";
import { modelIdForRole, type ModelRole, type ReasoningEffort } from "./officialCodexContracts";
import type { GitPreflight } from "./gitInspection";
import type { LatestGitImplementationResultStore } from "./latestGitImplementationResult";
import { MAX_CODEX_INSTRUCTION_BYTES } from "./reviewHandoffContracts";
import { GitImplementationResultLogger } from "./gitImplementationCommands";

export interface BrowserReviewExecutionCandidate {
  requestId: string; sourceRunId: string; envelopeSha256: string; decisionSha256: string;
  reviewedRepository: string; reviewedBranch: string; reviewedHeadSha: string;
  modelRole: ModelRole; reasoningEffort: ReasoningEffort; codexInstruction: string;
  reviewedAt: string; decisionAcknowledgedAt: string; instructionUtf8Bytes: number; instructionSha256: string;
}
export type BrowserReviewExecutionState = "available" | "confirmation_cancelled" | "reserved" | "running" | "completed" | "failed" | "cancelled" | "execution_error" | "superseded";
export interface BrowserReviewExecutionRecord extends BrowserReviewExecutionCandidate {
  repository: string; branch: string; reviewedHeadSha: string; candidateState: BrowserReviewCandidateState;
  executionRunId?: string; executionState: BrowserReviewExecutionState; startedAt?: string; finishedAt?: string;
  codexOutcome?: "completed" | "failed" | "cancelled"; gitDeliveryStatus?: string; resultHeadSha?: string; pushVerified?: boolean;
  resultAvailableForBrowserDelivery: boolean; failureCode?: string; failureMessage?: string;
  reviewCorrelationState: "current" | "superseded" | "revoked"; correlationClosedAt?: string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const OBJECT = /^[0-9a-f]{40,64}$/i;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export function validateBrowserReviewExecutionCandidate(value: unknown): asserts value is BrowserReviewExecutionCandidate {
  const c = value as BrowserReviewExecutionCandidate;
  if (!c || typeof c !== "object" || !UUID.test(c.requestId) || !UUID.test(c.sourceRunId) || !SHA.test(c.envelopeSha256) || !SHA.test(c.decisionSha256) || !SHA.test(c.instructionSha256) || !REPOSITORY.test(c.reviewedRepository) || !OBJECT.test(c.reviewedHeadSha) || typeof c.reviewedBranch !== "string" || !c.reviewedBranch.length || c.reviewedBranch.length > 255 || /[\0\r\n]/.test(c.reviewedBranch) || !["luna", "terra", "sol"].includes(c.modelRole) || !["low", "medium", "high", "xhigh"].includes(c.reasoningEffort) || !utc(c.reviewedAt) || !utc(c.decisionAcknowledgedAt) || typeof c.codexInstruction !== "string" || !c.codexInstruction.trim() || Buffer.byteLength(c.codexInstruction, "utf8") > MAX_CODEX_INSTRUCTION_BYTES || c.instructionUtf8Bytes !== Buffer.byteLength(c.codexInstruction, "utf8") || c.instructionSha256 !== createHash("sha256").update(c.codexInstruction, "utf8").digest("hex")) throw new Error("Invalid browser review execution candidate");
}
export function validateBrowserReviewExecutionRecord(value: unknown): asserts value is BrowserReviewExecutionRecord {
  validateBrowserReviewExecutionCandidate(value); const r = value as BrowserReviewExecutionRecord;
  if (r.repository !== r.reviewedRepository || r.branch !== r.reviewedBranch || !["unavailable", "available", "reserved", "consumed"].includes(r.candidateState) || !["available", "confirmation_cancelled", "reserved", "running", "completed", "failed", "cancelled", "execution_error", "superseded"].includes(r.executionState) || !["current", "superseded", "revoked"].includes(r.reviewCorrelationState) || typeof r.resultAvailableForBrowserDelivery !== "boolean" || (r.executionRunId !== undefined && !UUID.test(r.executionRunId)) || (r.startedAt !== undefined && !utc(r.startedAt)) || (r.finishedAt !== undefined && !utc(r.finishedAt)) || (r.codexOutcome !== undefined && !["completed", "failed", "cancelled"].includes(r.codexOutcome)) || (r.gitDeliveryStatus !== undefined && !DELIVERY.has(r.gitDeliveryStatus as GitDeliveryStatus)) || (r.resultHeadSha !== undefined && !OBJECT.test(r.resultHeadSha)) || (r.pushVerified !== undefined && typeof r.pushVerified !== "boolean") || (r.failureCode !== undefined && (!/^[A-Z_]{1,64}$/.test(r.failureCode))) || (r.failureMessage !== undefined && r.failureMessage.length > 300) || (r.correlationClosedAt !== undefined && !utc(r.correlationClosedAt))) throw new Error("Invalid browser review execution record");
}
const DELIVERY = new Set<GitDeliveryStatus>(["verified", "codex_not_completed", "branch_changed", "history_rewritten", "no_commit", "working_tree_dirty", "repository_mismatch", "push_not_verified", "git_inspection_failed"]);
export function isGitResultDeliverable(result: GitImplementationRunResult | null): boolean { try { if (!result) return false; const envelope = createImplementationReviewEnvelope(result); validateImplementationReviewEnvelope(envelope); serializeImplementationReviewEnvelope(envelope); return true; } catch { return false; } }
export type BrowserReviewCandidateState = "unavailable" | "available" | "reserved" | "consumed";
export interface BrowserReviewCandidateProvider {
  getExecutionCandidate(): BrowserReviewExecutionCandidate | null;
  reserveExecutionCandidate(key: Pick<BrowserReviewExecutionCandidate, "requestId" | "envelopeSha256" | "decisionSha256">): BrowserReviewExecutionCandidate | null;
  consumeExecutionCandidate(key: Pick<BrowserReviewExecutionCandidate, "requestId" | "envelopeSha256" | "decisionSha256">): boolean;
  getExecutionCandidateState(): BrowserReviewCandidateState;
  getLatestExecutionRecord(): BrowserReviewExecutionRecord | null;
  markExecutionRecord(key: Pick<BrowserReviewExecutionCandidate, "requestId" | "envelopeSha256" | "decisionSha256">, patch: Partial<BrowserReviewExecutionRecord>): void;
}
export interface BrowserReviewExecutionService {
  snapshot(workspacePath: string): Promise<GitPreflight>;
  run(argument: unknown): Promise<GitImplementationRunResult>;
}
export interface BrowserReviewExecutionUi {
  getOpenCanonicalWorkspace(): Promise<string>;
  confirmReviewedChange(details: BrowserReviewExecutionCandidate & { modelId: string }): Promise<boolean>;
  appendOutput(message: string): void;
  showError(message: string): void;
  showInformation?(message: string): void;
}

export class BrowserReviewExecutionController {
  constructor(private readonly candidates: BrowserReviewCandidateProvider, private readonly service: BrowserReviewExecutionService,
    private readonly results: LatestGitImplementationResultStore, private readonly ui: BrowserReviewExecutionUi,
    private readonly uuid: () => string, private readonly logger?: GitImplementationResultLogger) {}

  async run(): Promise<GitImplementationRunResult | undefined> {
    const candidate = this.candidates.getExecutionCandidate();
    if (!candidate) throw this.fail("No executable acknowledged CHANGES_REQUESTED browser review is available");
    validateBrowserReviewExecutionCandidate(candidate);
    const workspacePath = await this.ui.getOpenCanonicalWorkspace();
    const snapshot = await this.service.snapshot(workspacePath);
    if (!repositoryIdentityEquals(snapshot.repository, candidate.reviewedRepository) || snapshot.branch !== candidate.reviewedBranch || snapshot.baseSha !== candidate.reviewedHeadSha) {
      throw this.fail("Reviewed repository state no longer matches the browser decision");
    }
    this.writeInstruction(candidate);
    if (!(await this.ui.confirmReviewedChange({ ...candidate, modelId: modelIdForRole(candidate.modelRole) }))) {
      this.candidates.markExecutionRecord(pick(candidate), { executionState: "confirmation_cancelled" }); return undefined;
    }
    const key = pick(candidate);
    const runId = this.uuid();
    if (!UUID.test(runId)) throw this.fail("Browser review execution ID is invalid");
    const reserved = this.candidates.reserveExecutionCandidate(key);
    if (!reserved) throw this.fail("Browser review decision is stale or has already been used");
    // Consumption happens before invocation: an ambiguous/cancelled real turn is never replayed.
    if (!this.candidates.consumeExecutionCandidate(key)) throw this.fail("Browser review decision could not be consumed");
    this.candidates.markExecutionRecord(key, { candidateState: "consumed", executionRunId: runId, executionState: "running", startedAt: new Date().toISOString() });
    let result: GitImplementationRunResult;
    try {
      result = await this.service.run({ runId, workspacePath, prompt: reserved.codexInstruction,
        modelRole: reserved.modelRole, reasoningEffort: reserved.reasoningEffort,
        expectedGitHubRepository: reserved.reviewedRepository, expectedBranch: reserved.reviewedBranch, expectedBaseSha: reserved.reviewedHeadSha });
    } catch (error) {
      this.candidates.markExecutionRecord(key, { executionState: "execution_error", finishedAt: new Date().toISOString(), failureCode: "EXECUTION_FAILED", failureMessage: bounded(error), resultAvailableForBrowserDelivery: false });
      throw this.fail(`Reviewed execution failed: ${bounded(error)}`);
    }
    this.results.replace(result);
    this.logger?.log(result); if (!this.logger) this.log(result);
    this.candidates.markExecutionRecord(key, terminalResultRecordPatch(result, () => new Date()));
    return result;
  }

  show(): void {
    const record = this.candidates.getLatestExecutionRecord();
    if (!record) { const summary = "Browser review execution: no available record"; this.ui.appendOutput(summary); this.ui.showInformation?.(`Aiflow Browser Bridge: ${summary}`); return; }
    validateBrowserReviewExecutionRecord(record); this.writeInstruction(record);
    const resultMatch = record.executionRunId === this.results.get()?.runId; const deliverable = resultMatch && isGitResultDeliverable(this.results.get());
    const summary = `Browser review execution: request=${record.requestId}; source=${record.sourceRunId}; execution=${record.executionRunId ?? "<none>"}; state=${record.executionState}; correlation=${record.reviewCorrelationState}; candidate=${record.candidateState}; repository=${record.repository}; branch=${record.branch}; reviewed SHA=${record.reviewedHeadSha}; model=${record.modelRole}; reasoning=${record.reasoningEffort}; instruction bytes=${record.instructionUtf8Bytes}; instruction SHA=${record.instructionSha256}; started=${record.startedAt ?? "<none>"}; finished=${record.finishedAt ?? "<none>"}; Codex=${record.codexOutcome ?? "<none>"}; delivery=${record.gitDeliveryStatus ?? "<none>"}; head=${record.resultHeadSha ?? "<none>"}; push=${record.pushVerified ?? false}; result match=${resultMatch}; deliverable=${deliverable}; failure=${record.failureCode ?? "<none>"}:${record.failureMessage ?? "<none>"}`;
    this.ui.appendOutput(summary); this.ui.showInformation?.(`Aiflow Browser Bridge: ${summary.slice(0, 300)}`);
  }
  private writeInstruction(candidate: BrowserReviewExecutionCandidate): void { this.ui.appendOutput("--- Browser Review Codex Instruction (user-requested display) ---"); this.ui.appendOutput(candidate.codexInstruction); this.ui.appendOutput("--- End Browser Review Codex Instruction ---"); }
  private log(result: GitImplementationRunResult): void { this.ui.appendOutput(`review execution result: run=${result.runId}; repository=${result.git.githubRepository}; branch=${result.git.branch}; head=${result.git.headSha}; Codex=${result.codex.outcome}; delivery=${result.deliveryStatus}; push verified=${result.git.pushVerified}`); }
  private fail(message: string): Error { this.ui.showError(`Aiflow Browser Review: ${message}`); return new Error(message); }
}
export function createExecutionCandidate(value: Omit<BrowserReviewExecutionCandidate, "instructionUtf8Bytes" | "instructionSha256">): BrowserReviewExecutionCandidate {
  const instructionUtf8Bytes = Buffer.byteLength(value.codexInstruction, "utf8");
  const candidate = { ...value, instructionUtf8Bytes, instructionSha256: createHash("sha256").update(value.codexInstruction, "utf8").digest("hex") };
  validateBrowserReviewExecutionCandidate(candidate); return candidate;
}
export function terminalResultRecordPatch(result: GitImplementationRunResult, now: () => Date = () => new Date()): Partial<BrowserReviewExecutionRecord> {
  const head = /^[0-9a-f]{40,64}$/i.test(result.git.headSha) ? result.git.headSha : undefined;
  return { executionState: result.codex.outcome === "completed" ? "completed" : result.codex.outcome === "cancelled" ? "cancelled" : "failed", finishedAt: now().toISOString(), codexOutcome: result.codex.outcome, gitDeliveryStatus: result.deliveryStatus, ...(head ? { resultHeadSha: head } : {}), pushVerified: result.git.pushVerified, resultAvailableForBrowserDelivery: isGitResultDeliverable(result) };
}
function utc(value: unknown): boolean { if (typeof value !== "string") return false; const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value && value.endsWith("Z"); }
function pick(candidate: BrowserReviewExecutionCandidate) { return { requestId: candidate.requestId, envelopeSha256: candidate.envelopeSha256, decisionSha256: candidate.decisionSha256 }; }
function bounded(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 300); }
