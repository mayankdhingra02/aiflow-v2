import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  OFFICIAL_EXTENSION_ID,
  REQUESTED_MODEL,
  REQUESTED_REASONING,
  assertSupportedExtensionVersion,
  boundedErrorMessage,
} from "./constants";
import { CodexIpcClient } from "./ipcClient";
import {
  acceptanceMarker,
  bootstrapMarker,
  buildBootstrapInstruction,
  buildInterruptParams,
  buildOwnerDiscoveryParams,
  buildRealPrompt,
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
  type TerminalOutcome,
} from "./sessionStore";

interface ActiveProbe {
  phase: string;
  conversationId: string | null;
  ownerClientId: string | null;
  realTurnId: string | null;
  ipc: CodexIpcClient | null;
  cancelRequested: boolean;
  cancellationPromise: Promise<void> | null;
  cancellationConfirmed: boolean;
  terminalOutcomeLogged: boolean;
}

export class ProbeController implements vscode.Disposable {
  private active: ActiveProbe | null = null;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly extensionContext: vscode.ExtensionContext,
  ) {}

  async run(): Promise<void> {
    if (this.active) {
      this.output.show(true);
      this.output.appendLine("probe state: rejected (a probe is already active)");
      return;
    }

    const active: ActiveProbe = {
      phase: "starting",
      conversationId: null,
      ownerClientId: null,
      realTurnId: null,
      ipc: null,
      cancelRequested: false,
      cancellationPromise: null,
      cancellationConfirmed: false,
      terminalOutcomeLogged: false,
    };
    this.active = active;
    this.output.clear();
    this.output.show(true);

    try {
      this.state(active, "validating workspace");
      const canonicalWorkspace = await requireOneCanonicalWorkspace();

      this.state(active, "validating official extension");
      const officialExtension = vscode.extensions.getExtension(OFFICIAL_EXTENSION_ID);
      if (!officialExtension) {
        throw new Error(`${OFFICIAL_EXTENSION_ID} is not installed`);
      }
      const version = officialExtension.packageJSON.version as unknown;
      this.output.appendLine(`extension version: ${String(version)}`);
      assertSupportedExtensionVersion(version);
      await officialExtension.activate();
      if (!officialExtension.isActive) {
        throw new Error(`${OFFICIAL_EXTENSION_ID} did not become active`);
      }

      const sessionsRoot = path.join(os.homedir(), ".codex", "sessions");
      this.state(active, "snapshotting Codex sessions");
      const snapshot = await snapshotSessions(sessionsRoot);

      const nonce = generateNonce();
      const expectedBootstrapMarker = bootstrapMarker(nonce);
      const tempRoot = path.join(this.extensionContext.globalStorageUri.fsPath, "probe-temp");
      this.state(active, "invoking nonce-only bootstrap");
      const bootstrap = await withTemporaryBootstrapFile({
        tempRoot,
        canonicalWorkspace,
        run: async (temporaryFile) => {
          await vscode.commands.executeCommand("chatgpt.implementTodo", {
            fileName: temporaryFile,
            cwd: canonicalWorkspace,
            line: 1,
            comment: buildBootstrapInstruction(nonce),
          });

          this.state(active, "waiting for correlated bootstrap completion");
          return waitForBootstrapSession({
            sessionsRoot,
            snapshot,
            nonce,
            expectedMarker: expectedBootstrapMarker,
            canonicalWorkspace,
          });
        },
      });
      active.conversationId = bootstrap.conversationId;
      this.output.appendLine(`conversation ID: ${bootstrap.conversationId}`);
      this.output.appendLine(`bootstrap turn ID: ${bootstrap.bootstrapTurnId}`);

      const ipc = new CodexIpcClient({
        socketPath: path.join(os.homedir(), ".codex", "ipc", "ipc.sock"),
      });
      active.ipc = ipc;
      this.state(active, "initializing private IPC client");
      await ipc.connect();

      this.state(active, "discovering exact conversation owner");
      const ownerResponse = await ipc.request(
        "thread-owner-discovery",
        buildOwnerDiscoveryParams(bootstrap.conversationId),
      );
      active.ownerClientId = ownerClientIdFrom(ownerResponse);

      this.state(active, "applying model and reasoning");
      const settingsResponse = await ipc.request(
        "thread-follower-update-thread-settings",
        buildThreadSettingsParams(bootstrap.conversationId),
        { targetClientId: active.ownerClientId },
      );
      requireSettingsSuccess(settingsResponse);
      this.output.appendLine(`requested model: ${REQUESTED_MODEL}`);
      this.output.appendLine(`requested reasoning: ${REQUESTED_REASONING}`);

      const boundary = await captureSessionBoundary(bootstrap.sessionPath);
      const exactPrompt = buildRealPrompt(nonce);
      this.state(active, "starting exact real turn");
      const startResponse = await ipc.request(
        "thread-follower-start-turn",
        buildStartTurnParams(bootstrap.conversationId, exactPrompt),
        { targetClientId: active.ownerClientId },
      );
      active.realTurnId = turnIdFromStartResponse(startResponse);
      if (active.realTurnId) {
        this.output.appendLine(`real turn ID: ${active.realTurnId}`);
        await this.maybeCancel(active);
      }

      this.state(active, "watching exact correlated session and turn");
      const turnResult = await waitForExactTurn({
        sessionPath: bootstrap.sessionPath,
        conversationId: bootstrap.conversationId,
        boundary,
        exactPrompt,
        knownTurnId: active.realTurnId,
        onTurnId: async (turnId) => {
          if (!active.realTurnId) {
            active.realTurnId = turnId;
            this.output.appendLine(`real turn ID: ${turnId}`);
          }
          await this.maybeCancel(active);
        },
      });

      active.terminalOutcomeLogged = true;
      this.output.appendLine(`terminal outcome: ${turnResult.outcome}`);
      this.output.appendLine(`final response: ${turnResult.finalResponse}`);
      if (turnResult.outcome === "cancelled" && active.cancellationConfirmed) {
        this.state(active, "cancelled");
        void vscode.window.showInformationMessage("Aiflow official Codex probe cancelled.");
        return;
      }
      this.requireAcceptedTurn(turnResult.outcome, turnResult.finalResponse, nonce);
      if (turnResult.recordedModel !== REQUESTED_MODEL) {
        throw new Error("Real turn did not record the requested model");
      }
      if (turnResult.recordedReasoning !== REQUESTED_REASONING) {
        throw new Error("Real turn did not record the requested reasoning effort");
      }

      this.state(active, "completed");
      void vscode.window.showInformationMessage("Aiflow official Codex probe completed.");
    } catch (error) {
      this.state(active, "failed");
      if (!active.terminalOutcomeLogged) {
        this.output.appendLine(`terminal outcome: failed`);
      }
      const message = boundedErrorMessage(error);
      this.output.appendLine(`error: ${message}`);
      void vscode.window.showErrorMessage(`Aiflow probe failed: ${message}`);
    } finally {
      active.ipc?.dispose();
      if (this.active === active) {
        this.active = null;
      }
    }
  }

  async cancel(): Promise<void> {
    const active = this.active;
    this.output.show(true);
    if (!active) {
      this.output.appendLine("cancel: no active official Codex probe");
      return;
    }
    if (active.cancellationConfirmed) {
      this.output.appendLine("cancel: exact turn was already cancelled");
      return;
    }

    active.cancelRequested = true;
    if (!active.conversationId || !active.ownerClientId || !active.realTurnId || !active.ipc) {
      this.output.appendLine("cancel: queued until the exact real turn is known");
      return;
    }
    await this.maybeCancel(active);
  }

  dispose(): void {
    this.active?.ipc?.dispose();
    this.active = null;
  }

  private state(active: ActiveProbe, state: string): void {
    active.phase = state;
    this.output.appendLine(`probe state: ${state}`);
  }

  private async maybeCancel(active: ActiveProbe): Promise<void> {
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
          this.output.appendLine(`cancel: confirmed exact turn ${target.turnId}`);
        });
    }
    await active.cancellationPromise;
  }

  private requireAcceptedTurn(
    outcome: TerminalOutcome,
    finalResponse: string,
    nonce: string,
  ): void {
    if (outcome !== "completed") {
      throw new Error(`Real turn ended with outcome ${outcome}`);
    }
    if (finalResponse !== acceptanceMarker(nonce)) {
      throw new Error("Real turn response did not equal the requested acceptance marker");
    }
  }
}

async function requireOneCanonicalWorkspace(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length !== 1) {
    throw new Error("Open exactly one workspace folder before running the probe");
  }
  const [folder] = folders;
  if (folder.uri.scheme !== "file") {
    throw new Error("The probe requires one local file-system workspace folder");
  }
  const canonical = await fs.realpath(folder.uri.fsPath);
  const stats = await fs.stat(canonical);
  if (!stats.isDirectory()) {
    throw new Error("The open workspace folder is not a directory");
  }
  return canonical;
}
