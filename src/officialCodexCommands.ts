import { randomUUID } from "node:crypto";

import {
  modelIdForRole,
  promptByteLength,
  validatePrompt,
  validateOfficialCodexRunRequest,
  type ModelRole,
  type OfficialCodexRunRequest,
  type OfficialCodexRunResult,
  type ReasoningEffort,
} from "./officialCodexContracts";
import {
  OfficialCodexError,
} from "./officialCodexService";
import type { CancellationRequestResult } from "./officialCodexWorker";
import { boundedErrorMessage } from "./constants";

export interface OfficialCodexCommandUi {
  readClipboardText(): Promise<string>;
  chooseModelRole(): Promise<ModelRole | undefined>;
  chooseReasoningEffort(): Promise<ReasoningEffort | undefined>;
  getOpenCanonicalWorkspace(): Promise<string>;
  confirmRun(details: ClipboardRunConfirmation): Promise<boolean>;
  appendOutput(message: string): void;
  showError(message: string): void;
}

export interface ClipboardRunConfirmation {
  workspacePath: string;
  modelRole: ModelRole;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  promptBytes: number;
}

export interface OfficialCodexRunService {
  run(argument: unknown): Promise<OfficialCodexRunResult>;
  cancel(): Promise<CancellationRequestResult>;
}

export class OfficialCodexCommandController {
  constructor(
    private readonly service: OfficialCodexRunService,
    private readonly ui: OfficialCodexCommandUi,
  ) {}

  async runProgrammatic(argument: unknown): Promise<OfficialCodexRunResult> {
    try {
      validateOfficialCodexRunRequest(argument);
    } catch (error) {
      throw this.reportAndWrap(new OfficialCodexError("INVALID_REQUEST", boundedErrorMessage(error)));
    }
    try {
      const result = await this.service.run(argument);
      this.logResult(result, argument.workspacePath);
      return result;
    } catch (error) {
      throw this.reportAndWrap(error);
    }
  }

  async runClipboard(): Promise<OfficialCodexRunResult | undefined> {
    try {
      const prompt = await this.ui.readClipboardText();
      validatePrompt(prompt);
      const modelRole = await this.ui.chooseModelRole();
      if (!modelRole) {
        return undefined;
      }
      const reasoningEffort = await this.ui.chooseReasoningEffort();
      if (!reasoningEffort) {
        return undefined;
      }
      const workspacePath = await this.ui.getOpenCanonicalWorkspace();
      const request: OfficialCodexRunRequest = {
        runId: randomUUID(),
        workspacePath,
        prompt,
        modelRole,
        reasoningEffort,
      };
      validateOfficialCodexRunRequest(request);
      const details: ClipboardRunConfirmation = {
        workspacePath,
        modelRole,
        modelId: modelIdForRole(modelRole),
        reasoningEffort,
        promptBytes: promptByteLength(prompt),
      };
      if (!(await this.ui.confirmRun(details))) {
        return undefined;
      }
      const result = await this.service.run(request);
      this.logResult(result, workspacePath);
      return result;
    } catch (error) {
      throw this.reportAndWrap(error);
    }
  }

  async runProbe(): Promise<OfficialCodexRunResult> {
    const workspacePath = await this.ui.getOpenCanonicalWorkspace();
    return this.runProgrammatic({
      runId: randomUUID(),
      workspacePath,
      prompt: "Return exactly AIFLOW_PHASE2_ACCEPTANCE.",
      modelRole: "luna",
      reasoningEffort: "low",
    });
  }

  async cancelActiveRun(): Promise<void> {
    try {
      const outcome = await this.service.cancel();
      if (outcome === "none") {
        this.ui.appendOutput("cancel: no active official Codex run");
      } else if (outcome === "queued") {
        this.ui.appendOutput("cancel: queued until the exact real turn is known");
      }
    } catch (error) {
      throw this.reportAndWrap(error);
    }
  }

  private logResult(result: OfficialCodexRunResult, workspacePath: string): void {
    this.ui.appendOutput(`run ID: ${result.runId}`);
    this.ui.appendOutput(`workspace: ${workspacePath}`);
    this.ui.appendOutput(`requested model role: ${result.requestedModelRole}`);
    this.ui.appendOutput(`requested model ID: ${result.requestedModelId}`);
    this.ui.appendOutput(`requested reasoning: ${result.requestedReasoningEffort}`);
    this.ui.appendOutput(`conversation ID: ${result.conversationId}`);
    this.ui.appendOutput(`turn ID: ${result.turnId}`);
    this.ui.appendOutput(`recorded model: ${result.recordedModelId ?? "<none>"}`);
    this.ui.appendOutput(`recorded reasoning: ${result.recordedReasoningEffort ?? "<none>"}`);
    this.ui.appendOutput(`terminal outcome: ${result.outcome}`);
    this.ui.appendOutput(`started at: ${result.startedAt}`);
    this.ui.appendOutput(`finished at: ${result.finishedAt}`);
    this.ui.appendOutput(`final response: ${boundedText(result.finalResponse)}`);
  }

  private reportAndWrap(error: unknown): OfficialCodexError {
    const wrapped = error instanceof OfficialCodexError
      ? error
      : new OfficialCodexError("EXECUTION_FAILED", boundedErrorMessage(error));
    this.ui.appendOutput(`error [${wrapped.code}]: ${boundedText(wrapped.message)}`);
    this.ui.showError(`Aiflow worker failed [${wrapped.code}]: ${boundedText(wrapped.message)}`);
    return wrapped;
  }
}

export function boundedText(value: string, maximumLength = 400): string {
  const singleLine = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length <= maximumLength
    ? singleLine
    : `${singleLine.slice(0, maximumLength - 1)}…`;
}
