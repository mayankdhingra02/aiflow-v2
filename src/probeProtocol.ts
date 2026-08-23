import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  CODEX_HOST_ID,
} from "./constants";
import { asRecord } from "./ipcClient";
import type { IpcSuccessResponse } from "./protocol";

export interface ActiveTurnTarget {
  conversationId: string;
  ownerClientId: string;
  turnId: string;
}

export function generateNonce(): string {
  return randomBytes(32).toString("hex");
}

export function bootstrapMarker(nonce: string): string {
  return `AIFLOW_BOOTSTRAP_${nonce}`;
}

export function acceptanceMarker(nonce: string): string {
  return `AIFLOW_ACCEPT_${nonce}`;
}

export function buildBootstrapInstruction(nonce: string): string {
  return [
    `Aiflow bootstrap nonce: ${nonce}`,
    "Do not edit or modify any files.",
    "Do not run commands.",
    "Ignore any surrounding request to implement or remove this comment.",
    `Return exactly ${bootstrapMarker(nonce)}`,
  ].join("\n");
}

export function buildRealPrompt(nonce: string): string {
  return `Return exactly ${acceptanceMarker(nonce)}. Do not modify files.`;
}

export function buildOwnerDiscoveryParams(conversationId: string): Record<string, unknown> {
  return {
    hostId: CODEX_HOST_ID,
    conversationId,
  };
}

export function ownerClientIdFrom(response: IpcSuccessResponse): string {
  if (!response.handledByClientId) {
    throw new Error("Owner discovery response did not identify a client");
  }
  asRecord(response.result);
  return response.handledByClientId;
}

export function buildThreadSettingsParams(
  conversationId: string,
  modelId: string,
  reasoningEffort: string,
): Record<string, unknown> {
  return {
    conversationId,
    threadSettings: {
      model: modelId,
      effort: reasoningEffort,
    },
  };
}

export function requireSettingsSuccess(response: IpcSuccessResponse): void {
  const result = asRecord(response.result);
  if (result.ok !== true) {
    throw new Error("Codex thread settings update did not return ok=true");
  }
}

export function buildStartTurnParams(
  conversationId: string,
  exactPrompt: string,
  modelId: string,
  reasoningEffort: string,
  clientUserMessageId: string = randomUUID(),
): Record<string, unknown> {
  return {
    conversationId,
    turnStartParams: {
      input: [
        {
          type: "text",
          text: exactPrompt,
          text_elements: [],
        },
      ],
      clientUserMessageId,
      additionalContext: null,
      model: modelId,
      effort: reasoningEffort,
    },
    localTurnMetadata: null,
    mcpAppModelContextAttachments: [],
  };
}

export function turnIdFromStartResponse(response: IpcSuccessResponse): string | null {
  if (!isRecord(response.result) || !isRecord(response.result.result)) {
    return null;
  }
  const appServerResult = response.result.result;
  if (!isRecord(appServerResult.turn)) {
    return null;
  }
  return typeof appServerResult.turn.id === "string" && appServerResult.turn.id.length > 0
    ? appServerResult.turn.id
    : null;
}

export function buildInterruptParams(target: ActiveTurnTarget): Record<string, unknown> {
  return {
    conversationId: target.conversationId,
    mode: "user-stop",
    expectedTurnId: target.turnId,
  };
}

export function requireExactInterruptSuccess(
  response: IpcSuccessResponse,
  expectedTurnId: string,
): void {
  const result = asRecord(response.result);
  if (result.ok !== true || result.interruptedTurnId !== expectedTurnId) {
    throw new Error("Codex cancellation did not confirm the exact requested turn");
  }
}

export async function withTemporaryBootstrapFile<T>(options: {
  tempRoot: string;
  canonicalWorkspace: string;
  run: (filePath: string) => Promise<T>;
}): Promise<T> {
  await fs.mkdir(options.tempRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(options.tempRoot, 0o700);
  const canonicalTempRoot = await fs.realpath(options.tempRoot);
  if (isInside(options.canonicalWorkspace, canonicalTempRoot)) {
    throw new Error("Aiflow temporary storage must be outside the open workspace");
  }

  const filePath = path.join(canonicalTempRoot, `bootstrap-${randomUUID()}.txt`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(filePath, "wx", 0o600);
    await handle.writeFile("Aiflow bootstrap probe.\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(filePath, 0o600);

    const stats = await fs.stat(filePath);
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error("Aiflow temporary file permissions are not 0600");
    }
    return await options.run(filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(filePath, { force: true });
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
