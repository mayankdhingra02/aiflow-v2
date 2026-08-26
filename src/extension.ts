import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import {
  OfficialCodexCommandController,
  type ClipboardRunConfirmation,
  type OfficialCodexCommandUi,
} from "./officialCodexCommands";
import {
  GitImplementationCommandController,
  type GitImplementationCommandUi,
  type GitImplementationConfirmation,
} from "./gitImplementationCommands";
import { GitImplementationService } from "./gitImplementationService";
import {
  createWorkspaceAuthorizer,
  getOpenCanonicalWorkspace,
  OfficialCodexExecutionService,
  type OfficialExtensionResolver,
  type WorkspaceResolver,
} from "./officialCodexService";
import { createAppLifetimeOfficialCodexWorker } from "./appLifetimeWorker";
import { ProbeController } from "./probe";
import { BrowserBridge } from "./browserBridge";
import { resolveBrowserBridgePort } from "./browserBridgeProtocol";
import { modelIdForRole } from "./officialCodexContracts";
import type { ImplementationReviewEnvelopeV1 } from "./gitImplementationContracts";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Aiflow Official Codex Worker");
  const browserOutput = vscode.window.createOutputChannel("Aiflow Browser Bridge");
  const workspaceResolver = createVscodeWorkspaceResolver();
  const browserBridge = new BrowserBridge({
    port: () => resolveBrowserBridgePort(
      vscode.workspace.getConfiguration("aiflow.browserBridge").get<unknown>("port"),
    ),
    secrets: context.secrets,
    log: (message) => browserOutput.appendLine(message),
  });
  const worker = createAppLifetimeOfficialCodexWorker({
    sessionsRoot: path.join(os.homedir(), ".codex", "sessions"),
    tempRoot: path.join(context.globalStorageUri.fsPath, "worker-temp"),
    realTurnTimeoutMinutes: vscode.workspace
      .getConfiguration("aiflow.officialCodex")
      .get<unknown>("realTurnTimeoutMinutes"),
    authorizeWorkspace: createWorkspaceAuthorizer(workspaceResolver),
    invokeBootstrap: async ({ temporaryFile, workspacePath, instruction }) => {
      await vscode.commands.executeCommand("chatgpt.implementTodo", {
        fileName: temporaryFile,
        cwd: workspacePath,
        line: 1,
        comment: instruction,
      });
    },
    log: (message) => output.appendLine(message),
  });
  const service = new OfficialCodexExecutionService(
    worker,
    workspaceResolver,
    createVscodeExtensionResolver(),
  );
  const commandUi = createVscodeCommandUi(output, workspaceResolver);
  const commands = new OfficialCodexCommandController(service, commandUi);
  const gitCommands = new GitImplementationCommandController(
    new GitImplementationService(service, undefined, createWorkspaceAuthorizer(workspaceResolver)),
    createVscodeGitImplementationCommandUi(commandUi, output),
  );
  const probe = new ProbeController(commands);

  context.subscriptions.push(
    output,
    browserOutput,
    service,
    probe,
    { dispose: () => { void browserBridge.dispose(); } },
    vscode.commands.registerCommand("aiflow.runOfficialCodex", (argument: unknown) =>
      commands.runProgrammatic(argument),
    ),
    vscode.commands.registerCommand("aiflow.runClipboardOfficialCodex", () =>
      commands.runClipboard(),
    ),
    vscode.commands.registerCommand("aiflow.runGitImplementation", (argument: unknown) =>
      gitCommands.runProgrammatic(argument),
    ),
    vscode.commands.registerCommand("aiflow.runClipboardGitImplementation", () =>
      gitCommands.runClipboard(),
    ),
    vscode.commands.registerCommand("aiflow.cancelActiveOfficialCodexRun", () =>
      commands.cancelActiveRun(),
    ),
    vscode.commands.registerCommand("aiflow.runOfficialCodexProbe", () => probe.run()),
    vscode.commands.registerCommand("aiflow.cancelOfficialCodexProbe", () => probe.cancel()),
    vscode.commands.registerCommand("aiflow.pairBrowserBridge", async () => {
      try {
        const pairing = await browserBridge.beginPairing();
        const choice = await vscode.window.showInformationMessage(
          `Enter this one-time browser pairing code within five minutes: ${pairing.pairingCode}`,
          { modal: true },
          "Copy Pairing Code",
        );
        if (choice === "Copy Pairing Code") await vscode.env.clipboard.writeText(pairing.pairingCode);
      } catch (error) {
        void vscode.window.showErrorMessage(`Aiflow Browser Bridge: ${boundedBridgeError(error)}`);
      }
    }),
    vscode.commands.registerCommand("aiflow.revokeBrowserBridge", async () => {
      try {
        await browserBridge.revoke();
        void vscode.window.showInformationMessage("Aiflow Browser Bridge pairing revoked");
      } catch (error) {
        void vscode.window.showErrorMessage(`Aiflow Browser Bridge: ${boundedBridgeError(error)}`);
      }
    }),
    vscode.commands.registerCommand("aiflow.showBrowserBridgeStatus", async () => {
      const status = await browserBridge.status();
      void vscode.window.showInformationMessage(
        `Aiflow Browser Bridge: ${status.serverState}; port ${status.port ?? "not started"}; ${status.authenticated ? "authenticated" : "disconnected"}; ${status.pairedExtensionId ? `paired ${status.pairedExtensionId}` : "unpaired"}`,
      );
    }),
    vscode.commands.registerCommand("aiflow.sendImplementationReviewEnvelope", (argument: unknown) =>
      browserBridge.sendImplementationReviewEnvelope(argument),
    ),
    vscode.commands.registerCommand("aiflow.sendSyntheticReviewEnvelope", () =>
      browserBridge.sendImplementationReviewEnvelope(createSyntheticReviewEnvelope()),
    ),
    vscode.commands.registerCommand("aiflow.getLatestBrowserReviewDecision", () =>
      browserBridge.getLatestReviewDecision(),
    ),
    vscode.commands.registerCommand("aiflow.showLatestBrowserReviewDecision", () => {
      const result = browserBridge.getLatestReviewDecision();
      if (!result) {
        void vscode.window.showInformationMessage("Aiflow Browser Bridge: no validated browser review decision");
        return;
      }
      const decision = result.decision;
      const summary = [
        `Request: ${decision.requestId}`,
        `Run: ${decision.runId}`,
        `Verdict: ${decision.verdict}`,
        ...(decision.verdict === "CHANGES_REQUESTED" ? [`Model: ${decision.modelRole}`, `Reasoning: ${decision.reasoningEffort}`] : []),
        `Instruction present: ${decision.codexInstruction ? "yes" : "no"}`,
        `Acknowledged: ${result.acknowledgedAt}`,
      ].join("; ");
      browserOutput.appendLine("--- Latest Browser Review Decision ---");
      browserOutput.appendLine(summary);
      if (decision.codexInstruction) {
        browserOutput.appendLine("--- Codex Instruction (user-requested display) ---");
        browserOutput.appendLine(decision.codexInstruction);
        browserOutput.appendLine("--- End Codex Instruction ---");
      }
      void vscode.window.showInformationMessage(`Aiflow Browser Bridge: ${summary}`);
    }),
  );
}

function createVscodeGitImplementationCommandUi(
  base: OfficialCodexCommandUi,
  output: vscode.OutputChannel,
): GitImplementationCommandUi {
  return {
    ...base,
    async confirmGitImplementation(details: GitImplementationConfirmation) {
      const confirmation = await vscode.window.showWarningMessage(
        [
          "Run clipboard implementation through Official Codex?",
          `GitHub repository: ${details.githubRepository}`,
          `Branch: ${details.branch}`,
          `Base SHA: ${details.baseSha.slice(0, 12)}`,
          `Model: ${details.modelRole} (${details.modelId})`,
          `Reasoning: ${details.reasoningEffort}`,
          `Prompt bytes: ${details.promptBytes}`,
          "Aiflow will verify Git delivery but will not itself commit or push.",
        ].join("\n"),
        { modal: true },
        "Run",
      );
      return confirmation === "Run";
    },
    appendOutput: (message) => output.appendLine(message),
  };
}

export function deactivate(): void {}

function createSyntheticReviewEnvelope(): ImplementationReviewEnvelopeV1 {
  const now = new Date().toISOString();
  return {
    version: 1,
    runId: randomUUID(),
    githubRepository: "synthetic/aiflow-bridge",
    branch: "main",
    baseSha: "0".repeat(40),
    headSha: "1".repeat(40),
    commitShas: [],
    pushVerified: false,
    deliveryStatus: "no_commit",
    codexOutcome: "cancelled",
    codexFinalResponse: "Synthetic Phase 4A transport envelope.",
    modelRole: "terra",
    modelId: modelIdForRole("terra"),
    reasoningEffort: "medium",
    conversationId: randomUUID(),
    turnId: randomUUID(),
    startedAt: now,
    finishedAt: now,
  };
}

function boundedBridgeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

function createVscodeWorkspaceResolver(): WorkspaceResolver {
  return {
    async getWorkspaceFolders() {
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        scheme: folder.uri.scheme,
        path: folder.uri.fsPath,
      }));
    },
  };
}

function createVscodeExtensionResolver(): OfficialExtensionResolver {
  return {
    async getOfficialExtension(id) {
      const extension = vscode.extensions.getExtension(id);
      if (!extension) {
        return null;
      }
      return {
        get version(): unknown {
          return extension.packageJSON.version;
        },
        get isActive(): boolean {
          return extension.isActive;
        },
        activate: async () => {
          await extension.activate();
        },
      };
    },
  };
}

function createVscodeCommandUi(
  output: vscode.OutputChannel,
  workspaceResolver: WorkspaceResolver,
): OfficialCodexCommandUi {
  return {
    readClipboardText: async () => vscode.env.clipboard.readText(),
    async chooseModelRole() {
      const choice = await vscode.window.showQuickPick([
        { label: "Luna", value: "luna" as const },
        { label: "Terra", value: "terra" as const },
        { label: "Sol", value: "sol" as const },
      ], { title: "Choose Official Codex model" });
      return choice?.value;
    },
    async chooseReasoningEffort() {
      const choice = await vscode.window.showQuickPick([
        { label: "Low", value: "low" as const },
        { label: "Medium", value: "medium" as const },
        { label: "High", value: "high" as const },
        { label: "XHigh", value: "xhigh" as const },
      ], { title: "Choose Official Codex reasoning effort" });
      return choice?.value;
    },
    getOpenCanonicalWorkspace: () => getOpenCanonicalWorkspace(workspaceResolver),
    async confirmRun(details: ClipboardRunConfirmation) {
      const confirmation = await vscode.window.showWarningMessage(
        [
          "Run clipboard prompt through Official Codex?",
          `Workspace: ${details.workspacePath}`,
          `Model: ${details.modelRole} (${details.modelId})`,
          `Reasoning: ${details.reasoningEffort}`,
          `Prompt bytes: ${details.promptBytes}`,
        ].join("\n"),
        { modal: true },
        "Run",
      );
      return confirmation === "Run";
    },
    appendOutput: (message) => output.appendLine(message),
    showError: (message) => {
      void vscode.window.showErrorMessage(message);
    },
  };
}
