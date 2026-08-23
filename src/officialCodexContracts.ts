import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ModelRole = "luna" | "terra" | "sol";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export type OfficialCodexTerminalOutcome = "completed" | "failed" | "cancelled";

export const MAX_PROMPT_BYTES = 128 * 1024;

export interface OfficialCodexRunRequest {
  runId: string;
  workspacePath: string;
  prompt: string;
  modelRole: ModelRole;
  reasoningEffort: ReasoningEffort;
}

export interface OfficialCodexRunResult {
  runId: string;
  conversationId: string;
  turnId: string;
  outcome: OfficialCodexTerminalOutcome;
  finalResponse: string;
  requestedModelRole: ModelRole;
  requestedModelId: string;
  requestedReasoningEffort: ReasoningEffort;
  recordedModelId: string | null;
  recordedReasoningEffort: string | null;
  startedAt: string;
  finishedAt: string;
}

export const MODEL_ID_BY_ROLE: Readonly<Record<ModelRole, string>> = {
  luna: "gpt-5.6-luna",
  terra: "gpt-5.6-terra",
  sol: "gpt-5.6-sol",
};

export function modelIdForRole(role: ModelRole): string {
  return MODEL_ID_BY_ROLE[role];
}

export function validateOfficialCodexRunRequest(
  request: unknown,
): asserts request is OfficialCodexRunRequest {
  if (!isRecord(request)) {
    throw new Error("Official Codex run request must be an object");
  }
  requireUuid(request.runId);
  requireNonEmptyString(request.workspacePath, "workspacePath");
  if (!path.isAbsolute(request.workspacePath as string)) {
    throw new Error("Official Codex workspacePath must be absolute");
  }
  validatePrompt(request.prompt);
  if (!isModelRole(request.modelRole)) {
    throw new Error("Official Codex run request has an unsupported modelRole");
  }
  if (!isReasoningEffort(request.reasoningEffort)) {
    throw new Error("Official Codex run request has an unsupported reasoningEffort");
  }
}

export function promptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, "utf8");
}

export function validatePrompt(prompt: unknown): asserts prompt is string {
  requirePrompt(prompt);
}

export async function canonicalWorkspacePath(workspacePath: string): Promise<string> {
  if (!path.isAbsolute(workspacePath)) {
    throw new Error("Official Codex workspacePath must be absolute");
  }
  const canonical = await fs.realpath(workspacePath);
  const stats = await fs.stat(canonical);
  if (!stats.isDirectory()) {
    throw new Error("Official Codex workspacePath must be a directory");
  }
  return canonical;
}

function isModelRole(value: unknown): value is ModelRole {
  return value === "luna" || value === "terra" || value === "sol";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function requireNonEmptyString(value: unknown, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Official Codex run request requires a non-empty ${name}`);
  }
}

function requireUuid(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error("Official Codex run request requires a valid UUID runId");
  }
}

function requirePrompt(value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Official Codex run request requires a non-empty prompt");
  }
  if (promptByteLength(value) > MAX_PROMPT_BYTES) {
    throw new Error(`Official Codex run request prompt exceeds ${MAX_PROMPT_BYTES} UTF-8 bytes`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
