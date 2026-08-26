import { createHash } from "node:crypto";

import { repositoryIdentityEquals, type GitImplementationRunResult } from "./gitImplementationContracts";
import { modelIdForRole, type ModelRole, type ReasoningEffort } from "./officialCodexContracts";
import type { GitPreflight } from "./gitInspection";
import type { LatestGitImplementationResultStore } from "./latestGitImplementationResult";

export interface BrowserReviewExecutionCandidate {
  requestId: string; sourceRunId: string; envelopeSha256: string; decisionSha256: string;
  reviewedRepository: string; reviewedBranch: string; reviewedHeadSha: string;
  modelRole: ModelRole; reasoningEffort: ReasoningEffort; codexInstruction: string;
  reviewedAt: string; decisionAcknowledgedAt: string; instructionUtf8Bytes: number; instructionSha256: string;
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
}

export class BrowserReviewExecutionController {
  constructor(private readonly candidates: BrowserReviewCandidateProvider, private readonly service: BrowserReviewExecutionService,
    private readonly results: LatestGitImplementationResultStore, private readonly ui: BrowserReviewExecutionUi,
    private readonly uuid: () => string) {}

  async run(): Promise<GitImplementationRunResult | undefined> {
    const candidate = this.candidates.getExecutionCandidate();
    if (!candidate) throw this.fail("No executable acknowledged CHANGES_REQUESTED browser review is available");
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
    const result = await this.service.run({ runId: this.uuid(), workspacePath, prompt: reserved.codexInstruction,
      modelRole: reserved.modelRole, reasoningEffort: reserved.reasoningEffort,
      expectedGitHubRepository: reserved.reviewedRepository, expectedBranch: reserved.reviewedBranch, expectedBaseSha: reserved.reviewedHeadSha });
    this.results.replace(result);
    this.log(result);
    return result;
  }

  show(): void {
    const candidate = this.candidates.getExecutionCandidate();
    const state = this.candidates.getExecutionCandidateState();
    if (!candidate) { this.ui.appendOutput(`Browser review execution: ${state}`); return; }
    this.writeInstruction(candidate);
    this.ui.appendOutput(`Browser review execution: request=${candidate.requestId}; source=${candidate.sourceRunId}; state=${state}; repository=${candidate.reviewedRepository}; branch=${candidate.reviewedBranch}; reviewed SHA=${candidate.reviewedHeadSha}; model=${candidate.modelRole}; reasoning=${candidate.reasoningEffort}; instruction bytes=${candidate.instructionUtf8Bytes}; instruction SHA-256=${candidate.instructionSha256}`);
  }
  private writeInstruction(candidate: BrowserReviewExecutionCandidate): void { this.ui.appendOutput("--- Browser Review Codex Instruction (user-requested display) ---"); this.ui.appendOutput(candidate.codexInstruction); this.ui.appendOutput("--- End Browser Review Codex Instruction ---"); }
  private log(result: GitImplementationRunResult): void { this.ui.appendOutput(`review execution result: run=${result.runId}; repository=${result.git.githubRepository}; branch=${result.git.branch}; head=${result.git.headSha}; Codex=${result.codex.outcome}; delivery=${result.deliveryStatus}; push verified=${result.git.pushVerified}`); }
  private fail(message: string): Error { this.ui.showError(`Aiflow Browser Review: ${message}`); return new Error(message); }
}
export function createExecutionCandidate(value: Omit<BrowserReviewExecutionCandidate, "instructionUtf8Bytes" | "instructionSha256">): BrowserReviewExecutionCandidate {
  const instructionUtf8Bytes = Buffer.byteLength(value.codexInstruction, "utf8");
  return { ...value, instructionUtf8Bytes, instructionSha256: createHash("sha256").update(value.codexInstruction, "utf8").digest("hex") };
}
function pick(candidate: BrowserReviewExecutionCandidate) { return { requestId: candidate.requestId, envelopeSha256: candidate.envelopeSha256, decisionSha256: candidate.decisionSha256 }; }
