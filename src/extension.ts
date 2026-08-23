import * as os from "node:os";
import * as path from "node:path";
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
import { OfficialCodexWorker } from "./officialCodexWorker";
import { ProbeController } from "./probe";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Aiflow Official Codex Worker");
  const workspaceResolver = createVscodeWorkspaceResolver();
  const worker = new OfficialCodexWorker({
    sessionsRoot: path.join(os.homedir(), ".codex", "sessions"),
    tempRoot: path.join(context.globalStorageUri.fsPath, "worker-temp"),
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
    service,
    probe,
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
