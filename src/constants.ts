export const OFFICIAL_EXTENSION_ID = "openai.chatgpt";
export const OFFICIAL_EXTENSION_VERSION = "26.814.41407";

export const CODEX_HOST_ID = "local";

export const IPC_METHOD_VERSIONS = {
  initialize: 0,
  "thread-owner-discovery": 1,
  "thread-follower-update-thread-settings": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-interrupt-turn": 4,
} as const;

export const IPC_REQUEST_TIMEOUT_MS = 5_000;
export const IPC_CONNECT_TIMEOUT_MS = 5_000;
export const BOOTSTRAP_TIMEOUT_MS = 120_000;
export const DEFAULT_REAL_TURN_TIMEOUT_MINUTES = 60;
export const MIN_REAL_TURN_TIMEOUT_MINUTES = 3;
export const MAX_REAL_TURN_TIMEOUT_MINUTES = 240;
export const MILLISECONDS_PER_MINUTE = 60_000;
export const REAL_TURN_TIMEOUT_MS = DEFAULT_REAL_TURN_TIMEOUT_MINUTES * MILLISECONDS_PER_MINUTE;
export const SESSION_POLL_INTERVAL_MS = 500;

export type ProbeIpcMethod = keyof typeof IPC_METHOD_VERSIONS;

export function ipcVersionFor(method: ProbeIpcMethod): number {
  return IPC_METHOD_VERSIONS[method];
}

export type OfficialCodexConfigurationErrorCode = "INVALID_CONFIGURATION";

export class OfficialCodexConfigurationError extends Error {
  readonly code: OfficialCodexConfigurationErrorCode = "INVALID_CONFIGURATION";

  constructor(message: string) {
    super(boundedErrorMessage(message));
    this.name = "OfficialCodexConfigurationError";
  }
}

export function resolveRealTurnTimeoutMs(value: unknown): number {
  if (value === undefined) return REAL_TURN_TIMEOUT_MS;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_REAL_TURN_TIMEOUT_MINUTES ||
    value > MAX_REAL_TURN_TIMEOUT_MINUTES
  ) {
    throw new OfficialCodexConfigurationError(
      `aiflow.officialCodex.realTurnTimeoutMinutes must be a finite integer from ${MIN_REAL_TURN_TIMEOUT_MINUTES} through ${MAX_REAL_TURN_TIMEOUT_MINUTES}`,
    );
  }
  return value * MILLISECONDS_PER_MINUTE;
}

export function assertSupportedExtensionVersion(version: unknown): asserts version is string {
  if (version !== OFFICIAL_EXTENSION_VERSION) {
    throw new Error(
      `Unsupported openai.chatgpt version: expected ${OFFICIAL_EXTENSION_VERSION}, found ${String(version)}`,
    );
  }
}

export function boundedErrorMessage(error: unknown, maximumLength = 400): string {
  const raw = error instanceof Error ? error.message : String(error);
  const singleLine = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length <= maximumLength
    ? singleLine
    : `${singleLine.slice(0, maximumLength - 1)}…`;
}
