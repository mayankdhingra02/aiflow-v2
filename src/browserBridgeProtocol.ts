import { createHash, randomUUID } from "node:crypto";

import { boundedErrorMessage } from "./constants";
import {
  serializeImplementationReviewEnvelope,
  validateImplementationReviewEnvelope,
  type ImplementationReviewEnvelopeV1,
} from "./gitImplementationContracts";

export const BROWSER_BRIDGE_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_BROWSER_BRIDGE_PORT = 47_323;
export const MIN_BROWSER_BRIDGE_PORT = 1_024;
export const MAX_BROWSER_BRIDGE_PORT = 65_535;
export const MAX_BROWSER_BRIDGE_MESSAGE_BYTES = 1_048_576;
export const MAX_BROWSER_TEST_PROMPT_BYTES = 128 * 1_024;
export const BROWSER_BRIDGE_ACK_TIMEOUT_MS = 10_000;

export type BrowserBridgeMessageType =
  | "pair_request"
  | "pair_success"
  | "authenticate"
  | "authenticated"
  | "ping"
  | "pong"
  | "browser_test_prompt"
  | "implementation_review_envelope"
  | "review_request"
  | "review_decision"
  | "ack"
  | "error";

export interface BrowserBridgeMessageV1 {
  version: 1;
  id: string;
  type: BrowserBridgeMessageType;
  sentAt: string;
  replyTo?: string;
  payload: unknown;
}

export interface BrowserTestPromptPayload {
  text: string;
  utf8Bytes: number;
  sha256: string;
}

export class BrowserBridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(boundedErrorMessage(message));
    this.name = "BrowserBridgeError";
  }
}

const MESSAGE_TYPES = new Set<BrowserBridgeMessageType>([
  "pair_request", "pair_success", "authenticate", "authenticated", "ping", "pong",
  "browser_test_prompt", "implementation_review_envelope", "review_request", "review_decision", "ack", "error",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function resolveBrowserBridgePort(value: unknown): number {
  if (value === undefined) return DEFAULT_BROWSER_BRIDGE_PORT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_BROWSER_BRIDGE_PORT || value > MAX_BROWSER_BRIDGE_PORT) {
    throw new BrowserBridgeError(
      "INVALID_CONFIGURATION",
      `aiflow.browserBridge.port must be an integer from ${MIN_BROWSER_BRIDGE_PORT} through ${MAX_BROWSER_BRIDGE_PORT}`,
    );
  }
  return value;
}

export function parseBrowserBridgeMessage(raw: string): BrowserBridgeMessageV1 {
  if (Buffer.byteLength(raw, "utf8") > MAX_BROWSER_BRIDGE_MESSAGE_BYTES) {
    throw new BrowserBridgeError("MESSAGE_TOO_LARGE", "Browser bridge message exceeds 1 MiB");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BrowserBridgeError("MALFORMED_JSON", "Browser bridge message is not valid JSON");
  }
  validateBrowserBridgeMessage(value);
  return value;
}

export function validateBrowserBridgeMessage(value: unknown): asserts value is BrowserBridgeMessageV1 {
  if (!isRecord(value) || value.version !== BROWSER_BRIDGE_PROTOCOL_VERSION ||
      typeof value.id !== "string" || !UUID.test(value.id) ||
      typeof value.type !== "string" || !MESSAGE_TYPES.has(value.type as BrowserBridgeMessageType) ||
      typeof value.sentAt !== "string" || !isUtcIso(value.sentAt) ||
      (value.replyTo !== undefined && (typeof value.replyTo !== "string" || !UUID.test(value.replyTo)))) {
    throw new BrowserBridgeError("INVALID_MESSAGE", "Browser bridge message has invalid protocol fields");
  }
}

export function createBrowserBridgeMessage(
  type: BrowserBridgeMessageType,
  payload: unknown,
  now: () => Date = () => new Date(),
  replyTo?: string,
): BrowserBridgeMessageV1 {
  return { version: 1, id: randomUUID(), type, sentAt: now().toISOString(), ...(replyTo ? { replyTo } : {}), payload };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validateBrowserTestPromptPayload(value: unknown): asserts value is BrowserTestPromptPayload {
  if (!isRecord(value) || typeof value.text !== "string" || value.text.trim().length === 0 ||
      typeof value.utf8Bytes !== "number" || !Number.isSafeInteger(value.utf8Bytes) ||
      typeof value.sha256 !== "string") {
    throw new BrowserBridgeError("INVALID_TEST_PROMPT", "Browser test prompt has invalid fields");
  }
  const bytes = Buffer.byteLength(value.text, "utf8");
  if (bytes > MAX_BROWSER_TEST_PROMPT_BYTES || value.utf8Bytes !== bytes ||
      !/^[0-9a-f]{64}$/.test(value.sha256) || value.sha256 !== sha256Hex(value.text)) {
    throw new BrowserBridgeError("INVALID_TEST_PROMPT", "Browser test prompt byte count or SHA-256 does not match");
  }
}

export function reviewEnvelopeSha256(envelope: ImplementationReviewEnvelopeV1): string {
  validateImplementationReviewEnvelope(envelope);
  return sha256Hex(serializeImplementationReviewEnvelope(envelope));
}

export function isChromeExtensionOrigin(origin: string | undefined, extensionId: string): boolean {
  return origin === `chrome-extension://${extensionId}` && /^[a-p]{32}$/.test(extensionId);
}

export function isChromeExtensionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-p]{32}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUtcIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value && value.endsWith("Z");
}
