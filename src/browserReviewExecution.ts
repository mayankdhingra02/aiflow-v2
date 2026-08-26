import { createHash } from "node:crypto";

import { repositoryIdentityEquals, type GitImplementationRunResult } from "./gitImplementationContracts";
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
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const OBJECT = /^[0-9a-f]{40,64}$/i;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
export function validateBrowserReviewExecutionCandidate(value: unknown): asserts value is BrowserReviewExecutionCandidate {
  const c = value as BrowserReviewExecutionCandidate;
  if (!c || typeof c !== "object" || !UUID.test(c.requestId) || !UUID.test(c.sourceRunId) || !SHA.test(c.envelopeSha256) || !SHA.test(c.decisionSha256) || !SHA.test(c.instructionSha256) || !REPOSITORY.test(c.reviewedRepository) || !OBJECT.test(c.reviewedHeadSha) || typeof c.reviewedBranch !== "string" || !c.reviewedBranch.length || c.reviewedBranch.length > 255 || /[\0\r\n]/.test(c.reviewedBranch) || !["luna", "terra", "sol"].includes(c.modelRole) || !["low", "medium", "high", "xhigh"].includes(c.reasoningEffort) || !utc(c.reviewedAt) || !utc(c.decisionAcknowledgedAt) || typeof c.codexInstruction !== "string" || !c.codexInstruction.trim() || Buffer.byteLength(c.codexInstruction, "utf8") > MAX_CODEX_INSTRUCTION_BYTES || c.instructionUtf8Bytes !== Buffer.byteLength(c.codexInstruction, "utf8") || c.instructionSha256 !== createHash("sha256").update(c.codexInstruction, "utf8").digest("hex")) throw new Error("Invalid browser review execution candidate");
}
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
    const reserved = this.candidates.reserveExecutionCandidate(key);
    if (!reserved) throw this.fail("Browser review decision is stale or has already been used");
    // Consumption happens before invocation: an ambiguous/cancelled real turn is never replayed.
    if (!this.candidates.consumeExecutionCandidate(key)) throw this.fail("Browser review decision could not be consumed");
    const runId = this.uuid();
    if (!UUID.test(runId)) throw this.fail("Browser review execution ID is invalid");
    this.candidates.markExecutionRecord(key, { candidateState: "consumed", executionRunId: runId, executionState: "running", startedAt: new Date().toISOString() });
    try {
      const result = await this.service.run({ runId, workspacePath, prompt: reserved.codexInstruction,
        modelRole: reserved.modelRole, reasoningEffort: reserved.reasoningEffort,
        expectedGitHubRepository: reserved.reviewedRepository, expectedBranch: reserved.reviewedBranch, expectedBaseSha: reserved.reviewedHeadSha });
      this.results.replace(result);
      this.logger?.log(result); if (!this.logger) this.log(result);
      this.candidates.markExecutionRecord(key, { executionState: result.codex.outcome === "completed" ? "completed" : result.codex.outcome === "cancelled" ? "cancelled" : "failed", finishedAt: new Date().toISOString(), codexOutcome: result.codex.outcome, gitDeliveryStatus: result.deliveryStatus, resultHeadSha: result.git.headSha, pushVerified: result.git.pushVerified, resultAvailableForBrowserDelivery: true });
      return result;
    } catch (error) {
      this.candidates.markExecutionRecord(key, { executionState: "execution_error", finishedAt: new Date().toISOString(), failureCode: "EXECUTION_FAILED", failureMessage: bounded(error), resultAvailableForBrowserDelivery: false });
      throw this.fail(`Reviewed execution failed: ${bounded(error)}`);
    }
  }

  show(): void {
    const record = this.candidates.getLatestExecutionRecord();
    if (!record) { const summary = "Browser review execution: no available record"; this.ui.appendOutput(summary); this.ui.showInformation?.(`Aiflow Browser Bridge: ${summary}`); return; }
    validateBrowserReviewExecutionCandidate(record); this.writeInstruction(record);
    const available = record.executionRunId === this.results.get()?.runId;
    const summary = `Browser review execution: request=${record.requestId}; source=${record.sourceRunId}; execution=${record.executionRunId ?? "<none>"}; state=${record.executionState}; candidate=${record.candidateState}; repository=${record.repository}; branch=${record.branch}; reviewed SHA=${record.reviewedHeadSha}; result available=${available}`;
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
function utc(value: unknown): boolean { if (typeof value !== "string") return false; const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value && value.endsWith("Z"); }
function pick(candidate: BrowserReviewExecutionCandidate) { return { requestId: candidate.requestId, envelopeSha256: candidate.envelopeSha256, decisionSha256: candidate.decisionSha256 }; }
function bounded(error: unknown): string { return String(error instanceof Error ? error.message : error).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 300); }
