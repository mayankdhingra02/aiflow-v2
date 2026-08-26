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
    if (!(await this.ui.confirmReviewedChange({ ...candidate, modelId: modelIdForRole(candidate.modelRole) }))) return undefined;
    const key = pick(candidate);
    const reserved = this.candidates.reserveExecutionCandidate(key);
    if (!reserved) throw this.fail("Browser review decision is stale or has already been used");
    // Consumption happens before invocation: an ambiguous/cancelled real turn is never replayed.
    if (!this.candidates.consumeExecutionCandidate(key)) throw this.fail("Browser review decision could not be consumed");
    const runId = this.uuid();
    const result = await this.service.run({ runId, workspacePath, prompt: reserved.codexInstruction,
      modelRole: reserved.modelRole, reasoningEffort: reserved.reasoningEffort,
      expectedGitHubRepository: reserved.reviewedRepository, expectedBranch: reserved.reviewedBranch, expectedBaseSha: reserved.reviewedHeadSha });
    this.results.replace(result);
    this.logger?.log(result);
    if (!this.logger) this.log(result);
    return result;
  }

  show(): void {
    const candidate = this.candidates.getExecutionCandidate();
    const state = this.candidates.getExecutionCandidateState();
    if (!candidate) { const summary = `Browser review execution: ${state}`; this.ui.appendOutput(summary); this.ui.showInformation?.(`Aiflow Browser Bridge: ${summary}`); return; }
    this.writeInstruction(candidate);
    this.ui.appendOutput(`Browser review execution: request=${candidate.requestId}; source=${candidate.sourceRunId}; state=${state}; repository=${candidate.reviewedRepository}; branch=${candidate.reviewedBranch}; reviewed SHA=${candidate.reviewedHeadSha}; model=${candidate.modelRole}; reasoning=${candidate.reasoningEffort}; instruction bytes=${candidate.instructionUtf8Bytes}; instruction SHA-256=${candidate.instructionSha256}`);
    this.ui.showInformation?.(`Aiflow Browser Bridge: request=${candidate.requestId}; state=${state}; repository=${candidate.reviewedRepository}; branch=${candidate.reviewedBranch}; SHA=${candidate.reviewedHeadSha}; model=${candidate.modelRole}; reasoning=${candidate.reasoningEffort}`);
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
