import * as vscode from "vscode";

import { ProbeController } from "./probe";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Aiflow Official Codex Probe");
  const controller = new ProbeController(output, context);

  context.subscriptions.push(
    output,
    controller,
    vscode.commands.registerCommand("aiflow.runOfficialCodexProbe", () => controller.run()),
    vscode.commands.registerCommand("aiflow.cancelOfficialCodexProbe", () => controller.cancel()),
  );
}

export function deactivate(): void {}
