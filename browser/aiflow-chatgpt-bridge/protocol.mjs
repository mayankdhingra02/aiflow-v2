export const VERSION = 1;
export const MAX_MESSAGE_BYTES = 1_048_576;
export const MAX_PROMPT_BYTES = 128 * 1024;

const TYPES = new Set(["pair_request", "pair_success", "authenticate", "authenticated", "ping", "pong", "browser_test_prompt", "implementation_review_envelope", "ack", "error"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function message(type, payload, replyTo) {
  return { version: VERSION, id: crypto.randomUUID(), type, sentAt: new Date().toISOString(), ...(replyTo ? { replyTo } : {}), payload };
}

export function validateMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== VERSION || !UUID.test(value.id) || !TYPES.has(value.type) || typeof value.sentAt !== "string" || new Date(value.sentAt).toISOString() !== value.sentAt || (value.replyTo !== undefined && !UUID.test(value.replyTo))) {
    throw new Error("Invalid browser bridge message");
  }
  return value;
}

export async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function browserTestPromptPayload(text) {
  const utf8Bytes = new TextEncoder().encode(text).byteLength;
  if (!text.trim() || utf8Bytes > MAX_PROMPT_BYTES) throw new Error("Test prompt is empty or exceeds 128 KiB");
  return { text, utf8Bytes, sha256: await sha256(text) };
}

export function validateReviewEnvelope(value) {
  const required = ["runId", "githubRepository", "branch", "baseSha", "headSha", "deliveryStatus", "codexOutcome", "modelRole", "reasoningEffort"];
  if (!value || typeof value !== "object" || value.version !== 1 || required.some((key) => typeof value[key] !== "string") || typeof value.pushVerified !== "boolean") throw new Error("Invalid review envelope");
  return value;
}
