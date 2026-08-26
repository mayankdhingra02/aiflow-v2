export const VERSION = 1;
export const MAX_MESSAGE_BYTES = 1_048_576;
export const MAX_PROMPT_BYTES = 128 * 1024;

const TYPES = new Set(["pair_request", "pair_success", "authenticate", "authenticated", "ping", "pong", "browser_test_prompt", "implementation_review_envelope", "ack", "error"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const OBJECT_ID = /^[0-9a-f]{40,64}$/i;
const DELIVERY = new Set(["verified", "codex_not_completed", "branch_changed", "history_rewritten", "no_commit", "working_tree_dirty", "repository_mismatch", "push_not_verified", "git_inspection_failed"]);
const OUTCOMES = new Set(["completed", "failed", "cancelled"]);
const ROLES = new Set(["luna", "terra", "sol"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export function message(type, payload, replyTo, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? (() => crypto.randomUUID());
  return { version: VERSION, id: uuid(), type, sentAt: now().toISOString(), ...(replyTo ? { replyTo } : {}), payload };
}

export function validateMessage(value) {
  if (!isRecord(value) || value.version !== VERSION || typeof value.id !== "string" || !UUID.test(value.id) || !TYPES.has(value.type) || typeof value.sentAt !== "string" || !isUtcIso(value.sentAt) || (value.replyTo !== undefined && (typeof value.replyTo !== "string" || !UUID.test(value.replyTo)))) {
    throw new Error("Invalid browser bridge message");
  }
  return value;
}

export function parseInbound(data) {
  if (typeof data !== "string" || new TextEncoder().encode(data).byteLength > MAX_MESSAGE_BYTES) throw new Error("Invalid or oversized browser bridge frame");
  return validateMessage(JSON.parse(data));
}

export async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function browserTestPromptPayload(text) {
  const utf8Bytes = new TextEncoder().encode(text).byteLength;
  if (typeof text !== "string" || !text.trim() || utf8Bytes > MAX_PROMPT_BYTES) throw new Error("Test prompt is empty or exceeds 128 KiB");
  return { text, utf8Bytes, sha256: await sha256(text) };
}

export function validateReviewEnvelope(value) {
  if (!isRecord(value) || value.version !== 1 || typeof value.pushVerified !== "boolean" || !Array.isArray(value.commitShas)) throw new Error("Invalid review envelope");
  const strings = ["runId", "githubRepository", "branch", "baseSha", "headSha", "deliveryStatus", "codexOutcome", "codexFinalResponse", "modelRole", "modelId", "reasoningEffort", "conversationId", "turnId", "startedAt", "finishedAt"];
  if (strings.some((key) => typeof value[key] !== "string") || value.commitShas.some((commit) => typeof commit !== "string") ||
      !UUID.test(value.runId) || !UUID.test(value.conversationId) || !UUID.test(value.turnId) ||
      !REPOSITORY.test(value.githubRepository) || !OBJECT_ID.test(value.baseSha) || !OBJECT_ID.test(value.headSha) ||
      !value.commitShas.every((commit) => OBJECT_ID.test(commit)) || !DELIVERY.has(value.deliveryStatus) ||
      !OUTCOMES.has(value.codexOutcome) || !ROLES.has(value.modelRole) || !EFFORTS.has(value.reasoningEffort) ||
      !value.branch || value.branch.length > 255 || /[\0\r\n]/.test(value.branch) || value.codexFinalResponse.length > 4000 ||
      !isUtcIso(value.startedAt) || !isUtcIso(value.finishedAt)) throw new Error("Invalid review envelope");
  return value;
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isUtcIso(value) { const date = new Date(value); return !Number.isNaN(date.getTime()) && date.toISOString() === value && value.endsWith("Z"); }
