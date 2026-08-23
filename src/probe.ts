import type { OfficialCodexCommandController } from "./officialCodexCommands";

/**
 * Compatibility surface for the accepted Phase 1 commands. It deliberately
 * delegates to the app-lifetime command controller and never owns a worker.
 */
export class ProbeController {
  constructor(private readonly commands: OfficialCodexCommandController) {}

  async run(): Promise<void> {
    await this.commands.runProbe();
  }

  async cancel(): Promise<void> {
    await this.commands.cancelActiveRun();
  }

  dispose(): void {}
}
