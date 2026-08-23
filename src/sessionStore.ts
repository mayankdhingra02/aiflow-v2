import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  BOOTSTRAP_TIMEOUT_MS,
  REAL_TURN_TIMEOUT_MS,
  SESSION_POLL_INTERVAL_MS,
} from "./constants";

const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;

interface SessionFileDescriptor {
  canonicalPath: string;
  identity: string;
}

export interface SessionSnapshot {
  capturedAtMs: number;
  canonicalPaths: Set<string>;
  identities: Set<string>;
}

export interface SessionBoundary {
  recordCount: number;
  turnIds: Set<string>;
}

export type TerminalOutcome = "completed" | "failed" | "cancelled";

export interface BootstrapSession {
  sessionPath: string;
  conversationId: string;
  bootstrapTurnId: string;
  recordedCwd: string;
  finalResponse: string;
}

export interface TurnResult {
  conversationId: string;
  turnId: string;
  outcome: TerminalOutcome;
  finalResponse: string;
  recordedModel: string | null;
  recordedReasoning: string | null;
}

interface ParsedSession {
  records: Record<string, unknown>[];
}

interface BootstrapInspection {
  containsNonce: boolean;
  conversationId: string | null;
  recordedCwd: string | null;
  turnId: string | null;
  outcome: TerminalOutcome | null;
  finalResponse: string | null;
}

interface TurnInspection {
  turnId: string | null;
  promptCorrelated: boolean;
  outcome: TerminalOutcome | null;
  finalResponse: string | null;
  recordedModel: string | null;
  recordedReasoning: string | null;
}

export async function snapshotSessions(sessionsRoot: string): Promise<SessionSnapshot> {
  const descriptors = await listSessionFiles(sessionsRoot);
  return {
    capturedAtMs: Date.now(),
    canonicalPaths: new Set(descriptors.map((descriptor) => descriptor.canonicalPath)),
    identities: new Set(descriptors.map((descriptor) => descriptor.identity)),
  };
}

export async function findNewSessionPaths(
  sessionsRoot: string,
  snapshot: SessionSnapshot,
): Promise<string[]> {
  const descriptors = await listSessionFiles(sessionsRoot);
  return descriptors
    .filter(
      (descriptor) =>
        !snapshot.canonicalPaths.has(descriptor.canonicalPath) &&
        !snapshot.identities.has(descriptor.identity),
    )
    .map((descriptor) => descriptor.canonicalPath)
    .sort();
}

export async function findBootstrapMatches(
  sessionsRoot: string,
  snapshot: SessionSnapshot,
  nonce: string,
): Promise<Array<{ sessionPath: string; inspection: BootstrapInspection }>> {
  const candidates = await findNewSessionPaths(sessionsRoot, snapshot);
  const matches: Array<{ sessionPath: string; inspection: BootstrapInspection }> = [];

  for (const sessionPath of candidates) {
    const parsed = await readSession(sessionPath);
    const inspection = inspectBootstrapRecords(parsed.records, nonce);
    if (inspection.containsNonce) {
      matches.push({ sessionPath, inspection });
    }
  }
  return matches;
}

export async function waitForBootstrapSession(options: {
  sessionsRoot: string;
  snapshot: SessionSnapshot;
  nonce: string;
  expectedMarker: string;
  canonicalWorkspace: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<BootstrapSession> {
  const deadline = Date.now() + (options.timeoutMs ?? BOOTSTRAP_TIMEOUT_MS);

  while (Date.now() < deadline) {
    const matches = await findBootstrapMatches(
      options.sessionsRoot,
      options.snapshot,
      options.nonce,
    );
    if (matches.length > 1) {
      throw new Error("Multiple newly created Codex sessions contain the bootstrap nonce");
    }
    if (matches.length === 1) {
      const [{ sessionPath, inspection }] = matches;
      if (!inspection.conversationId || !inspection.recordedCwd || !inspection.turnId) {
        await delay(options.pollIntervalMs ?? SESSION_POLL_INTERVAL_MS);
        continue;
      }
      if (!(await canonicalPathsEqual(inspection.recordedCwd, options.canonicalWorkspace))) {
        throw new Error("Bootstrap session cwd does not match the open workspace");
      }
      if (inspection.outcome === "failed" || inspection.outcome === "cancelled") {
        throw new Error(`Bootstrap turn ended with outcome ${inspection.outcome}`);
      }
      if (inspection.outcome === "completed") {
        if (inspection.finalResponse !== options.expectedMarker) {
          throw new Error("Bootstrap response did not equal the requested marker");
        }
        return {
          sessionPath,
          conversationId: inspection.conversationId,
          bootstrapTurnId: inspection.turnId,
          recordedCwd: inspection.recordedCwd,
          finalResponse: inspection.finalResponse,
        };
      }
    }

    await delay(options.pollIntervalMs ?? SESSION_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for the nonce-correlated bootstrap turn");
}

export async function captureSessionBoundary(sessionPath: string): Promise<SessionBoundary> {
  const parsed = await readSession(sessionPath);
  return {
    recordCount: parsed.records.length,
    turnIds: new Set(allTurnIds(parsed.records)),
  };
}

export async function waitForExactTurn(options: {
  sessionPath: string;
  conversationId: string;
  boundary: SessionBoundary;
  exactPrompt: string;
  knownTurnId: string | null;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onTurnId?: (turnId: string) => void | Promise<void>;
}): Promise<TurnResult> {
  const deadline = Date.now() + (options.timeoutMs ?? REAL_TURN_TIMEOUT_MS);
  let emittedTurnId: string | null = null;

  while (Date.now() < deadline) {
    const parsed = await readSession(options.sessionPath);
    const fileConversationId = sessionConversationId(parsed.records);
    if (fileConversationId !== options.conversationId) {
      throw new Error("Correlated session conversation ID changed unexpectedly");
    }

    const inspection = inspectTurnRecords(
      parsed.records,
      options.boundary,
      options.exactPrompt,
      options.knownTurnId,
    );
    if (inspection.turnId && inspection.turnId !== emittedTurnId) {
      emittedTurnId = inspection.turnId;
      await options.onTurnId?.(inspection.turnId);
    }
    if (inspection.turnId && inspection.promptCorrelated && inspection.outcome) {
      return {
        conversationId: options.conversationId,
        turnId: inspection.turnId,
        outcome: inspection.outcome,
        finalResponse: inspection.finalResponse ?? "",
        recordedModel: inspection.recordedModel,
        recordedReasoning: inspection.recordedReasoning,
      };
    }

    await delay(options.pollIntervalMs ?? SESSION_POLL_INTERVAL_MS);
  }
  throw new Error("Timed out waiting for the exact real Codex turn");
}

export function inspectBootstrapRecords(
  records: Record<string, unknown>[],
  nonce: string,
): BootstrapInspection {
  let activeTurnId: string | null = null;
  let nonceTurnId: string | null = null;
  let containsNonce = false;
  const terminals = new Map<string, { outcome: TerminalOutcome; finalResponse: string | null }>();
  const agentMessages = new Map<string, string>();

  for (const record of records) {
    const payload = recordPayload(record);
    const payloadType = stringField(payload, "type");
    const turnId = stringField(payload, "turn_id");

    if (record.type === "event_msg" && payloadType === "task_started" && turnId) {
      activeTurnId = turnId;
    } else if (record.type === "turn_context" && turnId) {
      activeTurnId = turnId;
    }

    const userText = extractUserText(record, payload);
    if (userText?.includes(nonce)) {
      containsNonce = true;
      if (activeTurnId) {
        if (nonceTurnId && nonceTurnId !== activeTurnId) {
          throw new Error("Bootstrap nonce appeared in more than one turn in one session");
        }
        nonceTurnId = activeTurnId;
      }
    }

    const agentText = extractAgentText(record, payload);
    if (agentText !== null && activeTurnId) {
      agentMessages.set(activeTurnId, agentText);
    }

    if (turnId) {
      const terminal = terminalFromEvent(payloadType, payload);
      if (terminal) {
        terminals.set(turnId, terminal);
      }
    }
  }

  const terminal = nonceTurnId ? terminals.get(nonceTurnId) : undefined;
  return {
    containsNonce,
    conversationId: sessionConversationId(records),
    recordedCwd: sessionCwd(records),
    turnId: nonceTurnId,
    outcome: terminal?.outcome ?? null,
    finalResponse:
      terminal?.finalResponse ?? (nonceTurnId ? agentMessages.get(nonceTurnId) ?? null : null),
  };
}

export function inspectTurnRecords(
  records: Record<string, unknown>[],
  boundary: SessionBoundary,
  exactPrompt: string,
  knownTurnId: string | null,
): TurnInspection {
  if (knownTurnId && boundary.turnIds.has(knownTurnId)) {
    throw new Error("Real turn ID existed before the real-turn boundary");
  }

  let activeTurnId: string | null = null;
  const promptTurnIds = new Set<string>();
  const terminals = new Map<string, { outcome: TerminalOutcome; finalResponse: string | null }>();
  const agentMessages = new Map<string, string>();
  const contexts = new Map<string, { model: string | null; effort: string | null }>();

  for (const record of records.slice(boundary.recordCount)) {
    const payload = recordPayload(record);
    const payloadType = stringField(payload, "type");
    const turnId = stringField(payload, "turn_id");

    if (record.type === "event_msg" && payloadType === "task_started" && turnId) {
      activeTurnId = turnId;
    } else if (record.type === "turn_context" && turnId) {
      activeTurnId = turnId;
      contexts.set(turnId, {
        model: stringField(payload, "model"),
        effort: stringField(payload, "effort"),
      });
    }

    const userText = extractUserText(record, payload);
    if (userText === exactPrompt && activeTurnId) {
      promptTurnIds.add(activeTurnId);
    }

    const agentText = extractAgentText(record, payload);
    if (agentText !== null && activeTurnId) {
      agentMessages.set(activeTurnId, agentText);
    }

    if (turnId) {
      const terminal = terminalFromEvent(payloadType, payload);
      if (terminal) {
        terminals.set(turnId, terminal);
      }
    }
  }

  if (promptTurnIds.size > 1) {
    throw new Error("The exact real prompt appeared in multiple new turns");
  }
  const promptTurnId = promptTurnIds.values().next().value as string | undefined;
  if (knownTurnId && promptTurnId && knownTurnId !== promptTurnId) {
    throw new Error("Follower response turn ID does not match the prompt-correlated turn ID");
  }

  const turnId = knownTurnId ?? promptTurnId ?? null;
  const terminal = turnId ? terminals.get(turnId) : undefined;
  const context = turnId ? contexts.get(turnId) : undefined;
  return {
    turnId,
    promptCorrelated: turnId !== null && promptTurnIds.has(turnId),
    outcome: terminal?.outcome ?? null,
    finalResponse:
      terminal?.finalResponse ?? (turnId ? agentMessages.get(turnId) ?? null : null),
    recordedModel: context?.model ?? null,
    recordedReasoning: context?.effort ?? null,
  };
}

export async function canonicalPathsEqual(left: string, right: string): Promise<boolean> {
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([
      fs.realpath(left),
      fs.realpath(right),
    ]);
    return path.normalize(canonicalLeft) === path.normalize(canonicalRight);
  } catch {
    return false;
  }
}

async function listSessionFiles(root: string): Promise<SessionFileDescriptor[]> {
  const descriptors: SessionFileDescriptor[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const canonicalPath = await fs.realpath(entryPath);
        const stats = await fs.stat(canonicalPath);
        descriptors.push({
          canonicalPath,
          identity: `${stats.dev}:${stats.ino}`,
        });
      }
    }
  }

  await walk(root);
  return descriptors;
}

async function readSession(sessionPath: string): Promise<ParsedSession> {
  const stats = await fs.stat(sessionPath);
  if (stats.size > MAX_SESSION_FILE_BYTES) {
    throw new Error("Correlated Codex session file exceeded the probe size limit");
  }
  const content = await fs.readFile(sessionPath, "utf8");
  const rawLines = content.split("\n");
  const records: Record<string, unknown>[] = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      const isIncompleteLastLine = index === rawLines.length - 1 && !content.endsWith("\n");
      if (!isIncompleteLastLine) {
        throw new Error("Correlated Codex session contains invalid JSONL");
      }
    }
  }
  return { records };
}

function sessionConversationId(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    if (record.type !== "session_meta") {
      continue;
    }
    const payload = recordPayload(record);
    return stringField(payload, "id") ?? stringField(payload, "session_id");
  }
  return null;
}

function sessionCwd(records: Record<string, unknown>[]): string | null {
  for (const record of records) {
    if (record.type === "session_meta") {
      return stringField(recordPayload(record), "cwd");
    }
  }
  return null;
}

function allTurnIds(records: Record<string, unknown>[]): string[] {
  const result = new Set<string>();
  for (const record of records) {
    const turnId = stringField(recordPayload(record), "turn_id");
    if (turnId) {
      result.add(turnId);
    }
  }
  return [...result];
}

function extractUserText(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | null {
  if (record.type === "event_msg" && payload.type === "user_message") {
    return stringField(payload, "message");
  }
  if (record.type === "response_item" && payload.type === "message" && payload.role === "user") {
    return extractContentText(payload.content);
  }
  return null;
}

function extractAgentText(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
): string | null {
  if (record.type === "event_msg" && payload.type === "agent_message") {
    return stringField(payload, "message");
  }
  if (
    record.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "assistant"
  ) {
    return extractContentText(payload.content);
  }
  return null;
}

function extractContentText(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return "";
      }
      return stringField(item as Record<string, unknown>, "text") ?? "";
    })
    .join("");
  return text.length > 0 ? text : null;
}

function terminalFromEvent(
  payloadType: string | null,
  payload: Record<string, unknown>,
): { outcome: TerminalOutcome; finalResponse: string | null } | null {
  if (payloadType === "task_complete") {
    return {
      outcome: "completed",
      finalResponse: stringField(payload, "last_agent_message"),
    };
  }
  if (payloadType === "turn_aborted") {
    return { outcome: "cancelled", finalResponse: null };
  }
  if (payloadType === "task_failed" || payloadType === "turn_failed") {
    return { outcome: "failed", finalResponse: null };
  }
  return null;
}

function recordPayload(record: Record<string, unknown>): Record<string, unknown> {
  const payload = record.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
