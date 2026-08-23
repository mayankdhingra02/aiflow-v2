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
  return JSON.stringify(envelope);
}

function boundedFinalResponse(value: string): string {
  const maximumLength = 4_000;
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
