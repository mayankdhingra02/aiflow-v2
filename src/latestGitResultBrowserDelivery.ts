import { createImplementationReviewEnvelope, serializeImplementationReviewEnvelope, validateImplementationReviewEnvelope } from "./gitImplementationContracts";
import { reviewEnvelopeSha256 } from "./browserBridgeProtocol";
import type { LatestGitImplementationResultStore } from "./latestGitImplementationResult";
import type { BrowserReviewDeliveryResult } from "./browserBridge";

export interface ImplementationEnvelopeSender { sendImplementationReviewEnvelope(envelope: unknown): Promise<BrowserReviewDeliveryResult>; }
export interface LatestResultDeliveryUi { appendOutput(message: string): void; showInformation(message: string): void; showError(message: string): void; }
export class LatestGitResultBrowserDeliveryController {
  constructor(private readonly results: LatestGitImplementationResultStore, private readonly sender: ImplementationEnvelopeSender, private readonly ui: LatestResultDeliveryUi) {}
  async send(): Promise<BrowserReviewDeliveryResult> {
    try {
      const result = this.results.get();
      if (!result) throw new Error("No latest Git implementation result is available");
      const envelope = createImplementationReviewEnvelope(result); validateImplementationReviewEnvelope(envelope);
      serializeImplementationReviewEnvelope(envelope); const digest = reviewEnvelopeSha256(envelope);
      const delivery = await this.sender.sendImplementationReviewEnvelope(envelope);
      const message = `Git result delivered: run=${result.runId}; repository=${envelope.githubRepository}; branch=${envelope.branch}; head=${envelope.headSha}; sha256=${digest}; acknowledged=${delivery.acknowledgedAt}`;
      this.ui.appendOutput(message); this.ui.showInformation(`Aiflow Browser Bridge: ${message}`); return delivery;
    } catch (error) { const message = bounded(error); this.ui.appendOutput(`delivery error: ${message}`); this.ui.showError(`Aiflow Browser Bridge: ${message}`); throw new Error(message); }
  }
}
function bounded(error: unknown): string { const text = error instanceof Error ? error.message : String(error); return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); }
