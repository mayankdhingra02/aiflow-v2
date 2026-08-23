import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  OFFICIAL_EXTENSION_ID,
  assertSupportedExtensionVersion,
  boundedErrorMessage,
} from "./constants";
import { OfficialCodexWorker } from "./officialCodexWorker";

export class ProbeController implements vscode.Disposable {
  private readonly worker: OfficialCodexWorker;

  constructor(
    private readonly output: vscode.OutputChannel,
    extensionContext: vscode.ExtensionContext,
  ) {
    this.worker = new OfficialCodexWorker({
      sessionsRoot: path.join(os.homedir(), ".codex", "sessions"),
      tempRoot: path.join(extensionContext.globalStorageUri.fsPath, "probe-temp"),
      invokeBootstrap: async ({ temporaryFile, workspacePath, instruction }) => {
        await vscode.commands.executeCommand("chatgpt.implementTodo", {
          fileName: temporaryFile,
          cwd: workspacePath,
          line: 1,
          comment: instruction,
        });
      },
      log: (message) => this.output.appendLine(message),
    });
  }

  async run(): Promise<void> {
    this.output.show(true);
    if (this.worker.isActive) {
      this.output.appendLine("probe state: rejected (a run is already active)");
      return;
    }
    this.output.clear();
    this.output.show(true);

    try {
      this.state("validating workspace");
      const workspacePath = await requireOneCanonicalWorkspace();

      this.state("validating official extension");
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

      this.state("starting reusable official Codex worker");
      const result = await this.worker.run({
        runId: randomUUID(),
        workspacePath,
        prompt: "Return exactly AIFLOW_PHASE2_ACCEPTANCE.",
        modelRole: "luna",
        reasoningEffort: "low",
      });
      this.output.appendLine(`run ID: ${result.runId}`);
      this.output.appendLine(`conversation ID: ${result.conversationId}`);
      this.output.appendLine(`real turn ID: ${result.turnId}`);
      this.output.appendLine(`requested model: ${result.requestedModelId}`);
      this.output.appendLine(`requested reasoning: ${result.requestedReasoningEffort}`);
      this.output.appendLine(`terminal outcome: ${result.outcome}`);
      this.output.appendLine(`final response: ${result.finalResponse}`);
      this.state(result.outcome === "completed" ? "completed" : result.outcome);
      if (result.outcome === "completed") {
        void vscode.window.showInformationMessage("Aiflow official Codex worker completed.");
      }
    } catch (error) {
      this.state("failed");
      const message = boundedErrorMessage(error);
      this.output.appendLine("terminal outcome: failed");
      this.output.appendLine(`error: ${message}`);
      void vscode.window.showErrorMessage(`Aiflow worker failed: ${message}`);
    }
  }

  async cancel(): Promise<void> {
    this.output.show(true);
    const cancellation = await this.worker.cancel();
    if (cancellation === "none") {
      this.output.appendLine("cancel: no active official Codex run");
    } else if (cancellation === "queued") {
      this.output.appendLine("cancel: queued until the exact real turn is known");
    }
  }

  dispose(): void {
    this.worker.dispose();
  }

  private state(state: string): void {
    this.output.appendLine(`probe state: ${state}`);
  }
}

async function requireOneCanonicalWorkspace(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length !== 1) {
    throw new Error("Open exactly one workspace folder before running the worker");
  }
  const [folder] = folders;
  if (folder.uri.scheme !== "file") {
    throw new Error("The worker requires one local file-system workspace folder");
  }
  const canonical = await fs.realpath(folder.uri.fsPath);
  const stats = await fs.stat(canonical);
  if (!stats.isDirectory()) {
    throw new Error("The open workspace folder is not a directory");
  }
  return canonical;
}
