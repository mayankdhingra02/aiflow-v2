import { createImplementationReviewEnvelope, serializeImplementationReviewEnvelope, validateImplementationReviewEnvelope } from "./gitImplementationContracts";
import { reviewEnvelopeSha256 } from "./browserBridgeProtocol";
import type { LatestGitImplementationResultStore } from "./latestGitImplementationResult";
import type { BrowserReviewDeliveryResult } from "./browserBridge";

export interface ImplementationEnvelopeSender { sendImplementationReviewEnvelope(envelope: unknown): Promise<BrowserReviewDeliveryResult>; }
export interface LatestResultDeliveryUi { appendOutput(message: string): void; showInformation(message: string): void; showError(message: string): void; }
export class LatestGitResultBrowserDeliveryError extends Error { constructor(public readonly code: "RESULT_UNAVAILABLE" | "ENVELOPE_INVALID" | "DELIVERY_FAILED" | "ACKNOWLEDGEMENT_MISMATCH", message: string) { super(bounded(message)); this.name = "LatestGitResultBrowserDeliveryError"; } }
export class LatestGitResultBrowserDeliveryController {
  constructor(private readonly results: LatestGitImplementationResultStore, private readonly sender: ImplementationEnvelopeSender, private readonly ui: LatestResultDeliveryUi) {}
  async send(): Promise<BrowserReviewDeliveryResult> {
    try {
      const result = this.results.get();
      if (!result) throw new LatestGitResultBrowserDeliveryError("RESULT_UNAVAILABLE", "No latest Git implementation result is available");
      const envelope = createImplementationReviewEnvelope(result); validateImplementationReviewEnvelope(envelope);
      serializeImplementationReviewEnvelope(envelope); const digest = reviewEnvelopeSha256(envelope);
      let delivery: BrowserReviewDeliveryResult;
      try { delivery = await this.sender.sendImplementationReviewEnvelope(envelope); } catch { throw new LatestGitResultBrowserDeliveryError("DELIVERY_FAILED", "Browser result delivery failed"); }
      if (delivery.runId !== envelope.runId || delivery.envelopeSha256 !== digest || !uuid(delivery.bridgeMessageId) || !utc(delivery.acknowledgedAt)) throw new LatestGitResultBrowserDeliveryError("ACKNOWLEDGEMENT_MISMATCH", "Browser delivery acknowledgement did not match the result envelope");
      const message = `Git result delivered: run=${result.runId}; repository=${envelope.githubRepository}; branch=${envelope.branch}; head=${envelope.headSha}; sha256=${digest}; acknowledged=${delivery.acknowledgedAt}`;
      this.ui.appendOutput(message); this.ui.showInformation(`Aiflow Browser Bridge: ${message}`); return delivery;
    } catch (error) { const typed = error instanceof LatestGitResultBrowserDeliveryError ? error : new LatestGitResultBrowserDeliveryError("ENVELOPE_INVALID", "Git result envelope is invalid"); const message = typed.message; this.ui.appendOutput(`delivery error [${typed.code}]: ${message}`); this.ui.showError(`Aiflow Browser Bridge: ${message}`); throw typed; }
  }
}
function bounded(error: unknown): string { const text = error instanceof Error ? error.message : String(error); return text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function utc(value: unknown): boolean { if (typeof value !== "string") return false; const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value && value.endsWith("Z"); }
