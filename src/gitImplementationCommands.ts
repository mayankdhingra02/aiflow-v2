import { randomUUID } from "node:crypto";

import {
  createImplementationReviewEnvelope,
  gitImplementationError,
  serializeImplementationReviewEnvelope,
  validateGitImplementationRunRequest,
  type GitImplementationRunResult,
} from "./gitImplementationContracts";
import type { GitPreflight } from "./gitInspection";
import { modelIdForRole, promptByteLength, validatePrompt, type ModelRole, type ReasoningEffort } from "./officialCodexContracts";
import { boundedText, type OfficialCodexCommandUi } from "./officialCodexCommands";
import type { LatestGitImplementationResultStore } from "./latestGitImplementationResult";

export interface GitImplementationRunService {
  snapshot(workspacePath: string): Promise<GitPreflight>;
  run(argument: unknown): Promise<GitImplementationRunResult>;
}

export interface GitImplementationCommandUi extends OfficialCodexCommandUi {
  confirmGitImplementation(details: GitImplementationConfirmation): Promise<boolean>;
}

export interface GitImplementationConfirmation {
  githubRepository: string;
  branch: string;
  baseSha: string;
  modelRole: ModelRole;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  promptBytes: number;
}

export class GitImplementationCommandController {
  constructor(private readonly service: GitImplementationRunService, private readonly ui: GitImplementationCommandUi, private readonly resultSink?: LatestGitImplementationResultStore) {}

  async runProgrammatic(argument: unknown): Promise<GitImplementationRunResult> {
    try {
      validateGitImplementationRunRequest(argument);
      const result = await this.service.run(argument);
      this.resultSink?.replace(result);
      this.log(result);
      return result;
    } catch (error) {
      throw this.report(error, "INVALID_REQUEST", "Git implementation request is invalid");
    }
  }

  async runClipboard(): Promise<GitImplementationRunResult | undefined> {
    try {
      const prompt = await this.ui.readClipboardText();
      validatePrompt(prompt);
      const workspacePath = await this.ui.getOpenCanonicalWorkspace();
      const snapshot = await this.service.snapshot(workspacePath);
      const modelRole = await this.ui.chooseModelRole();
      if (!modelRole) return undefined;
      const reasoningEffort = await this.ui.chooseReasoningEffort();
      if (!reasoningEffort) return undefined;
      const details: GitImplementationConfirmation = {
        githubRepository: snapshot.repository,
        branch: snapshot.branch,
        baseSha: snapshot.baseSha,
        modelRole,
        modelId: modelIdForRole(modelRole),
        reasoningEffort,
        promptBytes: promptByteLength(prompt),
      };
      if (!(await this.ui.confirmGitImplementation(details))) return undefined;
      const result = await this.service.run({
        runId: randomUUID(), workspacePath, prompt, modelRole, reasoningEffort,
        expectedGitHubRepository: snapshot.repository,
        expectedBranch: snapshot.branch,
        expectedBaseSha: snapshot.baseSha,
      });
      this.resultSink?.replace(result);
      this.log(result);
      return result;
    } catch (error) {
      throw this.report(error, "INVALID_REQUEST", "Git implementation request is invalid");
    }
  }

  private log(result: GitImplementationRunResult): void {
    this.ui.appendOutput(`run ID: ${result.runId}`);
    this.ui.appendOutput(`GitHub repository: ${result.git.githubRepository}`);
    this.ui.appendOutput(`branch: ${result.git.branch}`);
    this.ui.appendOutput(`base SHA: ${result.git.baseSha}`);
    this.ui.appendOutput(`head SHA: ${result.git.headSha}`);
    this.ui.appendOutput(`created commits: ${result.git.commitShas.join(", ") || "<none>"}`);
    this.ui.appendOutput(`requested model: ${result.codex.requestedModelRole} (${result.codex.requestedModelId})`);
    this.ui.appendOutput(`requested reasoning: ${result.codex.requestedReasoningEffort}`);
    this.ui.appendOutput(`recorded model: ${result.codex.recordedModelId ?? "<none>"}`);
    this.ui.appendOutput(`recorded reasoning: ${result.codex.recordedReasoningEffort ?? "<none>"}`);
    this.ui.appendOutput(`Codex outcome: ${result.codex.outcome}`);
    this.ui.appendOutput(`delivery status: ${result.deliveryStatus}`);
    this.ui.appendOutput(`working tree: ${result.git.workingTreeClean ? "clean" : "dirty"}`);
    this.ui.appendOutput(`remote head SHA: ${result.git.remoteHeadSha ?? "<none>"}`);
    this.ui.appendOutput(`push verified: ${result.git.pushVerified}`);
    this.ui.appendOutput(`conversation ID: ${result.codex.conversationId}`);
    this.ui.appendOutput(`turn ID: ${result.codex.turnId}`);
    this.ui.appendOutput(`final response: ${boundedText(result.codex.finalResponse)}`);
    this.ui.appendOutput(`review envelope: ${serializeImplementationReviewEnvelope(createImplementationReviewEnvelope(result))}`);
  }

  private report(
    error: unknown,
    fallbackCode: "INVALID_REQUEST" | "GIT_EXECUTION_FAILED",
    fallbackMessage: string,
  ) {
    const typed = gitImplementationError(error, fallbackCode, fallbackMessage);
    const message = boundedText(typed.message, 300);
    this.ui.appendOutput(`error [${typed.code}]: ${message}`);
    this.ui.showError(`Aiflow Git delivery failed [${typed.code}]: ${message}`);
    return typed;
  }
}
