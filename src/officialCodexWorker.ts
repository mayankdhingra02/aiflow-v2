import * as os from "node:os";
import * as path from "node:path";

import { CodexIpcClient } from "./ipcClient";
import {
  IPC_CONNECT_TIMEOUT_MS,
  IPC_REQUEST_TIMEOUT_MS,
  type ProbeIpcMethod,
} from "./constants";
import {
  modelIdForRole,
  validateOfficialCodexRunRequest,
  type OfficialCodexRunRequest,
  type OfficialCodexRunResult,
} from "./officialCodexContracts";
import {
  bootstrapMarker,
  buildBootstrapInstruction,
  buildInterruptParams,
  buildOwnerDiscoveryParams,
  buildStartTurnParams,
  buildThreadSettingsParams,
  generateNonce,
  ownerClientIdFrom,
  requireExactInterruptSuccess,
  requireSettingsSuccess,
  turnIdFromStartResponse,
  withTemporaryBootstrapFile,
} from "./probeProtocol";
import {
  captureSessionBoundary,
  snapshotSessions,
  waitForBootstrapSession,
  waitForExactTurn,
} from "./sessionStore";
import type { IpcSuccessResponse } from "./protocol";

export type {
  ModelRole,
  OfficialCodexTerminalOutcome,
  OfficialCodexRunRequest,
  OfficialCodexRunResult,
  ReasoningEffort,
} from "./officialCodexContracts";

export interface OfficialCodexIpcClient {
  connect(): Promise<void>;
  request(
    method: ProbeIpcMethod,
    params: unknown,
    options?: {
      targetClientId?: string;
      timeoutMs?: number;
      sourceClientId?: string;
    },
  ): Promise<IpcSuccessResponse>;
  dispose(): void;
}

export interface BootstrapInvokerArguments {
  temporaryFile: string;
  workspacePath: string;
  nonce: string;
  instruction: string;
}

export interface OfficialCodexWorkerOptions {
  sessionsRoot: string;
  tempRoot: string;
  authorizeWorkspace: (workspacePath: string) => Promise<string>;
  socketPath?: string;
  invokeBootstrap: (arguments_: BootstrapInvokerArguments) => Promise<void>;
  createIpcClient?: (options: {
    socketPath: string;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
  }) => OfficialCodexIpcClient;
  log?: (message: string) => void;
  now?: () => Date;
  bootstrapTimeoutMs?: number;
  realTurnTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface ActiveRun {
  request: OfficialCodexRunRequest;
  conversationId: string | null;
  ownerClientId: string | null;
  realTurnId: string | null;
  ipc: OfficialCodexIpcClient | null;
  cancelRequested: boolean;
  cancellationPromise: Promise<void> | null;
  cancellationConfirmed: boolean;
}

export type CancellationRequestResult = "none" | "queued" | "requested";

export class OfficialCodexWorker {
  private active: ActiveRun | null = null;
  private runLock = false;
  private cancelRequestedBeforeActive = false;

  constructor(private readonly options: OfficialCodexWorkerOptions) {}

  async run(request: OfficialCodexRunRequest): Promise<OfficialCodexRunResult> {
    if (this.active || this.runLock) {
      throw new Error("An official Codex run is already active");
    }
    this.runLock = true;

    try {
      validateOfficialCodexRunRequest(request);
      const workspacePath = await this.options.authorizeWorkspace(request.workspacePath);
      const startedAt = this.timestamp();
      const active: ActiveRun = {
        request: { ...request, workspacePath },
        conversationId: null,
        ownerClientId: null,
        realTurnId: null,
        ipc: null,
        cancelRequested: this.cancelRequestedBeforeActive,
        cancellationPromise: null,
        cancellationConfirmed: false,
      };
      this.active = active;

      try {
        return await this.execute(active, workspacePath, startedAt);
      } finally {
        active.ipc?.dispose();
        if (this.active === active) {
          this.active = null;
        }
      }
    } finally {
      this.runLock = false;
      this.cancelRequestedBeforeActive = false;
    }
  }

  async cancel(): Promise<CancellationRequestResult> {
    const active = this.active;
    if (!active) {
      if (this.runLock) {
        this.cancelRequestedBeforeActive = true;
        return "queued";
      }
      return "none";
    }
    if (active.cancellationConfirmed) {
      return "requested";
    }

    active.cancelRequested = true;
    if (!active.conversationId || !active.ownerClientId || !active.realTurnId || !active.ipc) {
      this.options.log?.("cancel: queued until the exact real turn is known");
      return "queued";
    }
    await this.maybeCancel(active);
    return "requested";
  }

  get isActive(): boolean {
    return this.active !== null || this.runLock;
  }

  dispose(): void {
    this.active?.ipc?.dispose();
  }

  private async execute(
    active: ActiveRun,
    workspacePath: string,
    startedAt: string,
  ): Promise<OfficialCodexRunResult> {
    const request = active.request;
    const requestedModelId = modelIdForRole(request.modelRole);
    const nonce = generateNonce();
    const snapshot = await snapshotSessions(this.options.sessionsRoot);
    this.options.log?.("worker: invoking nonce-only bootstrap");
    const bootstrap = await withTemporaryBootstrapFile({
      tempRoot: this.options.tempRoot,
      canonicalWorkspace: workspacePath,
      run: async (temporaryFile) => {
        await this.options.invokeBootstrap({
          temporaryFile,
          workspacePath,
          nonce,
          instruction: buildBootstrapInstruction(nonce),
        });
        this.options.log?.("worker: waiting for correlated bootstrap completion");
        return waitForBootstrapSession({
          sessionsRoot: this.options.sessionsRoot,
          snapshot,
          nonce,
          expectedMarker: bootstrapMarker(nonce),
          canonicalWorkspace: workspacePath,
          timeoutMs: this.options.bootstrapTimeoutMs,
          pollIntervalMs: this.options.pollIntervalMs,
        });
      },
    });
    active.conversationId = bootstrap.conversationId;
    this.options.log?.(`bootstrap conversation ID: ${bootstrap.conversationId}`);
    this.options.log?.(`bootstrap turn ID: ${bootstrap.bootstrapTurnId}`);

    const ipc = (this.options.createIpcClient ?? ((options) => new CodexIpcClient(options)))({
      socketPath:
        this.options.socketPath ?? path.join(os.homedir(), ".codex", "ipc", "ipc.sock"),
      connectTimeoutMs: IPC_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: IPC_REQUEST_TIMEOUT_MS,
    });
    active.ipc = ipc;
    await ipc.connect();

    const ownerResponse = await ipc.request(
      "thread-owner-discovery",
      buildOwnerDiscoveryParams(bootstrap.conversationId),
    );
    active.ownerClientId = ownerClientIdFrom(ownerResponse);

    const settingsResponse = await ipc.request(
      "thread-follower-update-thread-settings",
      buildThreadSettingsParams(
        bootstrap.conversationId,
        requestedModelId,
        request.reasoningEffort,
      ),
      { targetClientId: active.ownerClientId },
    );
    requireSettingsSuccess(settingsResponse);

    const boundary = await captureSessionBoundary(bootstrap.sessionPath);
    this.options.log?.("worker: starting exact real turn");
    const startResponse = await ipc.request(
      "thread-follower-start-turn",
      buildStartTurnParams(
        bootstrap.conversationId,
        request.prompt,
        requestedModelId,
        request.reasoningEffort,
      ),
      { targetClientId: active.ownerClientId },
    );
    active.realTurnId = turnIdFromStartResponse(startResponse);
    if (active.realTurnId) {
      this.options.log?.(`worker: real turn ID: ${active.realTurnId}`);
      await this.maybeCancel(active);
    }

    const turnResult = await waitForExactTurn({
      sessionPath: bootstrap.sessionPath,
      conversationId: bootstrap.conversationId,
      boundary,
      exactPrompt: request.prompt,
      knownTurnId: active.realTurnId,
      timeoutMs: this.options.realTurnTimeoutMs,
      pollIntervalMs: this.options.pollIntervalMs,
      sessionsRoot: this.options.sessionsRoot,
      onTimeoutDiagnostics: (diagnostics) => {
        this.options.log?.(
          `watcher timeout: conversation=${diagnostics.conversationId} ` +
          `turn=${diagnostics.knownTurnId ?? "<none>"} ` +
          `session=${diagnostics.sessionFilename} ` +
          `turnObserved=${diagnostics.knownTurnObserved} ` +
          `promptObserved=${diagnostics.exactPromptObserved} ` +
          `terminals=${diagnostics.terminalEventTypes.join(",") || "<none>"} ` +
          `otherCandidate=${diagnostics.anotherSameConversationCandidate}`,
        );
      },
      onTurnId: async (turnId) => {
        if (!active.realTurnId) {
          active.realTurnId = turnId;
        }
        await this.maybeCancel(active);
      },
    });

    const finishedAt = this.timestamp();
    return {
      runId: request.runId,
      conversationId: turnResult.conversationId,
      turnId: turnResult.turnId,
      outcome: turnResult.outcome,
      finalResponse: turnResult.finalResponse,
      requestedModelRole: request.modelRole,
      requestedModelId,
      requestedReasoningEffort: request.reasoningEffort,
      recordedModelId: turnResult.recordedModel,
      recordedReasoningEffort: turnResult.recordedReasoning,
      startedAt,
      finishedAt,
    };
  }

  private async maybeCancel(active: ActiveRun): Promise<void> {
    if (!active.cancelRequested || active.cancellationConfirmed) {
      return;
    }
    if (!active.conversationId || !active.ownerClientId || !active.realTurnId || !active.ipc) {
      return;
    }
    if (!active.cancellationPromise) {
      const target = {
        conversationId: active.conversationId,
        ownerClientId: active.ownerClientId,
        turnId: active.realTurnId,
      };
      active.cancellationPromise = active.ipc
        .request(
          "thread-follower-interrupt-turn",
          buildInterruptParams(target),
          { targetClientId: target.ownerClientId },
        )
        .then((response) => {
          requireExactInterruptSuccess(response, target.turnId);
          active.cancellationConfirmed = true;
          this.options.log?.(`cancel: confirmed exact turn ${target.turnId}`);
        });
    }
    await active.cancellationPromise;
  }

  private timestamp(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}
