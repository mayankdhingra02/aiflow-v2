import {
  type GitDeliveryEvidence,
  type GitDeliveryStatus,
  type GitImplementationRunRequest,
  type GitImplementationRunResult,
  repositoryIdentityEquals,
  validateGitImplementationRunRequest,
} from "./gitImplementationContracts";
import { GitInspection, GitInspectionError, type GitPreflight } from "./gitInspection";
import { canonicalWorkspacePath } from "./officialCodexContracts";
import type { OfficialCodexRunService } from "./officialCodexCommands";

export class GitImplementationService {
  private active = false;

  constructor(
    private readonly officialCodex: OfficialCodexRunService,
    private readonly git: GitInspection = new GitInspection(),
    private readonly authorizeWorkspace: (workspacePath: string) => Promise<string> = canonicalWorkspacePath,
  ) {}

  async snapshot(workspacePath: string): Promise<GitPreflight> {
    return this.git.snapshot(await this.authorizeWorkspace(workspacePath));
  }

  async run(argument: unknown): Promise<GitImplementationRunResult> {
    validateGitImplementationRunRequest(argument);
    if (this.active) throw new GitInspectionError("RUN_ACTIVE", "A Git implementation run is already active");
    this.active = true;
    try {
      const workspacePath = await this.authorizeWorkspace(argument.workspacePath);
      const request = { ...argument, workspacePath };
      const preflight = await this.git.preflight(workspacePath, request);
      const codex = await this.officialCodex.run(request);
      try {
        const evidence = await this.git.inspectAfterRun(workspacePath, preflight);
        const isAncestor = await this.git.isBaseAncestor(workspacePath, preflight.baseSha, evidence.headSha);
        return {
          runId: request.runId,
          deliveryStatus: deliveryStatus(codex.outcome, request, preflight, evidence, isAncestor),
          codex,
          git: evidence,
        };
      } catch {
        return {
          runId: argument.runId,
          deliveryStatus: "git_inspection_failed",
          codex,
          git: unavailableEvidence(preflight),
        };
      }
    } finally {
      this.active = false;
    }
  }

  async cancel() { return this.officialCodex.cancel(); }
}

function unavailableEvidence(preflight: GitPreflight): GitDeliveryEvidence {
  return {
    githubRepository: preflight.repository,
    branch: preflight.branch,
    baseSha: preflight.baseSha,
    headSha: "",
    commitShas: [],
    workingTreeClean: false,
    upstreamRemote: preflight.upstreamRemote,
    upstreamRef: preflight.upstreamRef,
    remoteHeadSha: null,
    pushVerified: false,
  };
}

// Precedence after a completed inspection: Codex terminal state, repository identity, branch,
// ancestry, commits, cleanliness, then remote proof. This makes status deterministic.
export function deliveryStatus(
  outcome: "completed" | "failed" | "cancelled",
  request: GitImplementationRunRequest,
  preflight: GitPreflight,
  evidence: GitDeliveryEvidence,
  baseIsAncestor: boolean,
): GitDeliveryStatus {
  if (outcome !== "completed") return "codex_not_completed";
  if (!repositoryIdentityEquals(evidence.githubRepository, request.expectedGitHubRepository) || !repositoryIdentityEquals(evidence.githubRepository, preflight.repository)) return "repository_mismatch";
  if (evidence.branch !== request.expectedBranch) return "branch_changed";
  if (!baseIsAncestor) return "history_rewritten";
  if (evidence.commitShas.length === 0) return "no_commit";
  if (!evidence.workingTreeClean) return "working_tree_dirty";
  if (!evidence.pushVerified) return "push_not_verified";
  return "verified";
}
