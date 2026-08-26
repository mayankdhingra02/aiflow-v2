import { MAX_REVIEW_HANDOFF_BYTES } from "./protocol.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export async function runtimeMessage(sendMessage, request, validate = (value) => value) {
  const value = await sendMessage(request);
  if (isRecord(value) && "error" in value) {
    if (typeof value.error === "string" && value.error.trim().length > 0 && value.error.length <= 300 && !/[\r\n\t]/.test(value.error)) {
      throw new Error(value.error);
    }
    throw new Error("Browser bridge returned an invalid error response");
  }
  return validate(value);
}

export function validateReviewRequestText(value) {
  if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > MAX_REVIEW_HANDOFF_BYTES) {
    throw new Error("Browser bridge returned an invalid review request");
  }
  return value;
}

export function validateReviewDecisionAcknowledgement(value) {
  if (!isRecord(value) || "browserToken" in value || !UUID.test(asString(value.requestId)) ||
      !UUID.test(asString(value.runId)) || !SHA256.test(asString(value.envelopeSha256)) ||
      (value.verdict !== "SHIP" && value.verdict !== "CHANGES_REQUESTED") || !SHA256.test(asString(value.decisionSha256)) ||
      !isUtcIso(asString(value.acknowledgedAt))) {
    throw new Error("Browser bridge returned an invalid review decision acknowledgement");
  }
  return {
    requestId: value.requestId,
    runId: value.runId,
    envelopeSha256: value.envelopeSha256,
    verdict: value.verdict,
    decisionSha256: value.decisionSha256,
    acknowledgedAt: value.acknowledgedAt,
  };
}

export function sanitizePopupState(value) {
  if (!isRecord(value) || "browserToken" in value) throw new Error("Browser bridge returned an invalid popup state");
  return value;
}

export function createReviewPopupActions({ sendMessage, writeClipboard, getPastedResponse, clearPastedResponse, setStatus }) {
  return {
    async copyReviewRequest() {
      try {
        const request = await runtimeMessage(sendMessage, { action: "createReviewRequest" }, validateReviewRequestText);
        await writeClipboard(request);
        setStatus("Review request copied. Paste it manually into ChatGPT.");
        return request;
      } catch (error) {
        setStatus(`Copy unavailable: ${bounded(error)}`);
        return null;
      }
    },
    async sendReviewDecision() {
      try {
        const acknowledgement = await runtimeMessage(
          sendMessage,
          { action: "sendReviewDecision", text: getPastedResponse() },
          validateReviewDecisionAcknowledgement,
        );
        clearPastedResponse();
        setStatus(`Accepted ${acknowledgement.verdict} · acknowledged ${acknowledgement.acknowledgedAt}`);
        return acknowledgement;
      } catch (error) {
        setStatus(`Review rejected: ${bounded(error)}`);
        return null;
      }
    },
  };
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asString(value) { return typeof value === "string" ? value : ""; }
function isUtcIso(value) { const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value && value.endsWith("Z"); }
function bounded(error) { return String(error?.message ?? error).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200); }
