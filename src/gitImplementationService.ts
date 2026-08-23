import {
  type GitDeliveryEvidence,
  type GitDeliveryStatus,
  type GitImplementationRunRequest,
  type GitImplementationRunResult,
  GitImplementationError,
  gitImplementationError,
  repositoryIdentityEquals,
  validateGitImplementationRunRequest,
} from "./gitImplementationContracts";
import type { OfficialCodexRunResult } from "./officialCodexContracts";
import { GitInspection, type GitPreflight } from "./gitInspection";
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
    try {
      return await this.git.snapshot(await this.authorizeWorkspace(workspacePath));
    } catch (error) {
      throw gitImplementationError(error, "GIT_PREFLIGHT_FAILED", "Git preflight failed");
    }
  }

  async run(argument: unknown): Promise<GitImplementationRunResult> {
    try {
      validateGitImplementationRunRequest(argument);
    } catch (error) {
      throw gitImplementationError(error, "INVALID_REQUEST", "Git implementation request is invalid");
    }
    if (this.active) throw new GitImplementationError("RUN_ACTIVE", "A Git implementation run is already active");
    this.active = true;
    try {
      let workspacePath: string;
      let request: GitImplementationRunRequest;
      let preflight: GitPreflight;
      try {
        workspacePath = await this.authorizeWorkspace(argument.workspacePath);
        request = { ...argument, workspacePath };
        preflight = await this.git.preflight(workspacePath, request);
      } catch (error) {
        throw gitImplementationError(error, "GIT_PREFLIGHT_FAILED", "Git preflight failed");
      }
      let codex: OfficialCodexRunResult;
      try {
        codex = await this.officialCodex.run(request);
      } catch (error) {
        throw gitImplementationError(error, "GIT_EXECUTION_FAILED", "Official Codex execution failed");
      }
      try {
        if (codex.outcome !== "completed") {
          return {
            runId: request.runId,
            deliveryStatus: "codex_not_completed",
            codex,
            git: unavailableEvidence(preflight),
          };
        }
        const localInspection = await this.git.inspectLocalAfterRun(workspacePath, preflight);
        if (localInspection.deliveryStatus) {
          return {
            runId: request.runId,
            deliveryStatus: localInspection.deliveryStatus,
            codex,
            git: localInspection.evidence,
          };
        }
        const remoteHeadSha = await this.git.verifyRemoteHead(workspacePath, preflight);
        const evidence = {
          ...localInspection.evidence,
          remoteHeadSha,
          pushVerified: remoteHeadSha === localInspection.evidence.headSha,
        };
        return {
          runId: request.runId,
          deliveryStatus: evidence.pushVerified ? "verified" : "push_not_verified",
          codex,
          git: evidence,
        };
      } catch {
        return {
          runId: request.runId,
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
  upstreamUnchanged: boolean,
): GitDeliveryStatus {
  if (outcome !== "completed") return "codex_not_completed";
  if (!repositoryIdentityEquals(evidence.githubRepository, request.expectedGitHubRepository) || !repositoryIdentityEquals(evidence.githubRepository, preflight.repository)) return "repository_mismatch";
  if (evidence.branch !== request.expectedBranch) return "branch_changed";
  if (!baseIsAncestor) return "history_rewritten";
  if (evidence.commitShas.length === 0) return "no_commit";
  if (!evidence.workingTreeClean) return "working_tree_dirty";
  if (!upstreamUnchanged) return "push_not_verified";
  if (!evidence.pushVerified) return "push_not_verified";
  return "verified";
}
