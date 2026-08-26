import {
  type ModelRole,
  type OfficialCodexRunRequest,
  type OfficialCodexRunResult,
  type ReasoningEffort,
  validateOfficialCodexRunRequest,
} from "./officialCodexContracts";

export interface GitImplementationRunRequest extends OfficialCodexRunRequest {
  expectedGitHubRepository: string;
  expectedBranch: string;
  expectedBaseSha: string;
}

export type GitDeliveryStatus =
  | "verified"
  | "codex_not_completed"
  | "branch_changed"
  | "history_rewritten"
  | "no_commit"
  | "working_tree_dirty"
  | "repository_mismatch"
  | "push_not_verified"
  | "git_inspection_failed";

export type GitImplementationErrorCode =
  | "INVALID_REQUEST"
  | "RUN_ACTIVE"
  | "GIT_PREFLIGHT_FAILED"
  | "GIT_EXECUTION_FAILED"
  | "GIT_INSPECTION_FAILED";

export class GitImplementationError extends Error {
  constructor(public readonly code: GitImplementationErrorCode, message: string) {
    super(boundedSingleLine(message));
    this.name = "GitImplementationError";
  }
}

export function gitImplementationError(
  error: unknown,
  fallbackCode: GitImplementationErrorCode,
  fallbackMessage: string,
): GitImplementationError {
  if (error instanceof GitImplementationError) return error;
  return new GitImplementationError(fallbackCode, fallbackMessage);
}

export interface GitDeliveryEvidence {
  githubRepository: string;
  branch: string;
  baseSha: string;
  headSha: string;
  commitShas: string[];
  workingTreeClean: boolean;
  upstreamRemote: string;
  upstreamRef: string;
  remoteHeadSha: string | null;
  pushVerified: boolean;
}

export interface GitImplementationRunResult {
  runId: string;
  deliveryStatus: GitDeliveryStatus;
  codex: OfficialCodexRunResult;
  git: GitDeliveryEvidence;
}

export interface ImplementationReviewEnvelopeV1 {
  version: 1;
  runId: string;
  githubRepository: string;
  branch: string;
  baseSha: string;
  headSha: string;
  commitShas: string[];
  pushVerified: boolean;
  deliveryStatus: GitDeliveryStatus;
  codexOutcome: "completed" | "failed" | "cancelled";
  codexFinalResponse: string;
  modelRole: ModelRole;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  conversationId: string;
  turnId: string;
  startedAt: string;
  finishedAt: string;
}

const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const FULL_OBJECT_ID = /^[0-9a-f]{40,64}$/i;
const MAX_BRANCH_LENGTH = 255;
const DELIVERY_STATUSES = new Set<GitDeliveryStatus>([
  "verified", "codex_not_completed", "branch_changed", "history_rewritten", "no_commit",
  "working_tree_dirty", "repository_mismatch", "push_not_verified", "git_inspection_failed",
]);
const CODEX_OUTCOMES = new Set(["completed", "failed", "cancelled"]);
const MODEL_ROLES = new Set(["luna", "terra", "sol"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export function validateGitImplementationRunRequest(
  request: unknown,
): asserts request is GitImplementationRunRequest {
  validateOfficialCodexRunRequest(request);
  const candidate = request as unknown as Record<string, unknown>;
  if (typeof candidate.expectedGitHubRepository !== "string" || !GITHUB_REPOSITORY.test(candidate.expectedGitHubRepository)) {
    throw new Error("Git implementation request requires expectedGitHubRepository as owner/repository");
  }
  if (
    typeof candidate.expectedBranch !== "string" ||
    candidate.expectedBranch.length === 0 ||
    candidate.expectedBranch.length > MAX_BRANCH_LENGTH ||
    /[\0\r\n]/.test(candidate.expectedBranch)
  ) {
    throw new Error("Git implementation request requires a bounded expectedBranch");
  }
  if (typeof candidate.expectedBaseSha !== "string" || !FULL_OBJECT_ID.test(candidate.expectedBaseSha)) {
    throw new Error("Git implementation request requires a full expectedBaseSha object ID");
  }
}

export function repositoryIdentityEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function createImplementationReviewEnvelope(
  result: GitImplementationRunResult,
): ImplementationReviewEnvelopeV1 {
  return {
    version: 1,
    runId: result.runId,
    githubRepository: result.git.githubRepository,
    branch: result.git.branch,
    baseSha: result.git.baseSha,
    headSha: result.git.headSha,
    commitShas: [...result.git.commitShas],
    pushVerified: result.git.pushVerified,
    deliveryStatus: result.deliveryStatus,
    codexOutcome: result.codex.outcome,
    codexFinalResponse: boundedFinalResponse(result.codex.finalResponse),
    modelRole: result.codex.requestedModelRole,
    modelId: result.codex.requestedModelId,
    reasoningEffort: result.codex.requestedReasoningEffort,
    conversationId: result.codex.conversationId,
    turnId: result.codex.turnId,
    startedAt: result.codex.startedAt,
    finishedAt: result.codex.finishedAt,
  };
}

export function serializeImplementationReviewEnvelope(
  envelope: ImplementationReviewEnvelopeV1,
): string {
  return JSON.stringify({
    version: envelope.version,
    runId: envelope.runId,
    githubRepository: envelope.githubRepository,
    branch: envelope.branch,
    baseSha: envelope.baseSha,
    headSha: envelope.headSha,
    commitShas: envelope.commitShas,
    pushVerified: envelope.pushVerified,
    deliveryStatus: envelope.deliveryStatus,
    codexOutcome: envelope.codexOutcome,
    codexFinalResponse: envelope.codexFinalResponse,
    modelRole: envelope.modelRole,
    modelId: envelope.modelId,
    reasoningEffort: envelope.reasoningEffort,
    conversationId: envelope.conversationId,
    turnId: envelope.turnId,
    startedAt: envelope.startedAt,
    finishedAt: envelope.finishedAt,
  });
}

export function validateImplementationReviewEnvelope(
  envelope: unknown,
): asserts envelope is ImplementationReviewEnvelopeV1 {
  if (!isRecord(envelope) || envelope.version !== 1) {
    throw new Error("Implementation review envelope must be version 1");
  }
  const strings = [
    "runId", "githubRepository", "branch", "baseSha", "headSha", "deliveryStatus",
    "codexOutcome", "codexFinalResponse", "modelRole", "modelId", "reasoningEffort",
    "conversationId", "turnId", "startedAt", "finishedAt",
  ];
  if (strings.some((key) => typeof envelope[key] !== "string") ||
      !Array.isArray(envelope.commitShas) ||
      envelope.commitShas.some((value) => typeof value !== "string") ||
      typeof envelope.pushVerified !== "boolean") {
    throw new Error("Implementation review envelope has invalid fields");
  }
  if (!GITHUB_REPOSITORY.test(envelope.githubRepository as string) ||
      !FULL_OBJECT_ID.test(envelope.baseSha as string) ||
      !FULL_OBJECT_ID.test(envelope.headSha as string) ||
      !(envelope.commitShas as unknown[]).every((value) => FULL_OBJECT_ID.test(value as string)) ||
      !DELIVERY_STATUSES.has(envelope.deliveryStatus as GitDeliveryStatus) ||
      !CODEX_OUTCOMES.has(envelope.codexOutcome as string) ||
      !MODEL_ROLES.has(envelope.modelRole as string) ||
      !REASONING_EFFORTS.has(envelope.reasoningEffort as string) ||
      (envelope.branch as string).length === 0 || (envelope.branch as string).length > MAX_BRANCH_LENGTH ||
      /[\0\r\n]/.test(envelope.branch as string) || (envelope.codexFinalResponse as string).length > 4_000 ||
      !isUuid(envelope.runId as string) || !isUuid(envelope.conversationId as string) ||
      !isUuid(envelope.turnId as string) || !isUtcIso(envelope.startedAt as string) ||
      !isUtcIso(envelope.finishedAt as string)) {
    throw new Error("Implementation review envelope contains invalid identifiers");
  }
}

function boundedFinalResponse(value: string): string {
  const maximumLength = 4_000;
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

function boundedSingleLine(value: string): string {
  const singleLine = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return singleLine.length <= 400 ? singleLine : `${singleLine.slice(0, 399)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isUtcIso(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value && value.endsWith("Z");
}
