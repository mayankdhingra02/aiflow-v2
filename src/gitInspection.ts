import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";

import {
  GitImplementationError,
  repositoryIdentityEquals,
  type GitDeliveryEvidence,
  type GitImplementationRunRequest,
} from "./gitImplementationContracts";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_COMMITS = 100;
const GIT_TIMEOUT_MS = 10_000;
const FULL_OBJECT_ID = /^[0-9a-f]{40,64}$/i;
const SAFE_REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface GitRunner {
  run(cwd: string, args: readonly string[]): Promise<string>;
  isAncestor?(cwd: string, baseSha: string, headSha: string): Promise<boolean>;
}

export const systemGitRunner: GitRunner = {
  async run(cwd, args) {
    try {
      const result = await execFileAsync("git", [...args], {
        cwd,
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      return boundedOutput(result.stdout);
    } catch {
      // Process diagnostics can contain credential-bearing remote URLs; never surface them.
      throw new GitImplementationError("GIT_INSPECTION_FAILED", "Git inspection command failed");
    }
  },
  async isAncestor(cwd, baseSha, headSha) {
    try {
      await execFileAsync("git", ["merge-base", "--is-ancestor", baseSha, headSha], {
        cwd,
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      return true;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 1) {
        return false;
      }
      throw new GitImplementationError("GIT_INSPECTION_FAILED", "Git ancestry inspection failed");
    }
  },
};

export interface GitPreflight {
  repository: string;
  branch: string;
  baseSha: string;
  upstreamRemote: string;
  upstreamRef: string;
  remoteBranchRef: string;
}

export interface GitPostflightInspection {
  evidence: GitDeliveryEvidence;
  baseIsAncestor: boolean;
  upstreamUnchanged: boolean;
}

export class GitInspection {
  constructor(
    private readonly runner: GitRunner = systemGitRunner,
    private readonly canonicalizePath: (value: string) => Promise<string> = fs.realpath,
  ) {}

  async preflight(workspacePath: string, request: GitImplementationRunRequest): Promise<GitPreflight> {
    try {
      await this.requireRepositoryRoot(workspacePath);
      await this.requireClean(workspacePath);
      const branch = await this.currentBranch(workspacePath);
      if (!branch || branch !== request.expectedBranch) throw new Error("Current Git branch does not match the expected branch");
      const baseSha = await this.currentHead(workspacePath);
      if (baseSha !== request.expectedBaseSha) throw new Error("Current Git HEAD does not match the expected base SHA");
      await this.runner.run(workspacePath, ["rev-parse", "--verify", `${request.expectedBaseSha}^{object}`]);
      const upstream = await this.currentUpstream(workspacePath, branch);
      if (!upstream) throw new Error("Current Git branch must have an upstream remote branch");
      const remoteBranchRef = remoteRefForUpstream(upstream.ref, upstream.remote);
      if (!remoteBranchRef || !isSafeRemoteName(upstream.remote)) throw new Error("Current Git upstream is invalid");
      const repository = await this.repositoryForRemote(workspacePath, upstream.remote);
      if (!repository || !repositoryIdentityEquals(repository, request.expectedGitHubRepository)) {
        throw new Error("GitHub repository does not match the expected repository");
      }
      return { repository, branch, baseSha, upstreamRemote: upstream.remote, upstreamRef: upstream.ref, remoteBranchRef };
    } catch (error) {
      throw asWorkflowError(error, "GIT_PREFLIGHT_FAILED", "Git preflight failed");
    }
  }

  async snapshot(workspacePath: string): Promise<GitPreflight> {
    try {
      await this.requireRepositoryRoot(workspacePath);
      await this.requireClean(workspacePath);
      const branch = await this.currentBranch(workspacePath);
      const baseSha = await this.currentHead(workspacePath);
      const upstream = branch ? await this.currentUpstream(workspacePath, branch) : null;
      if (!branch || !upstream) throw new Error("Current Git branch must have an upstream remote branch");
      const remoteBranchRef = remoteRefForUpstream(upstream.ref, upstream.remote);
      if (!remoteBranchRef || !isSafeRemoteName(upstream.remote)) throw new Error("Current Git upstream is invalid");
      const repository = await this.repositoryForRemote(workspacePath, upstream.remote);
      if (!repository) throw new Error("Git remote is not a recognized GitHub repository");
      return { repository, branch, baseSha, upstreamRemote: upstream.remote, upstreamRef: upstream.ref, remoteBranchRef };
    } catch (error) {
      throw asWorkflowError(error, "GIT_PREFLIGHT_FAILED", "Git preflight failed");
    }
  }

  async inspectAfterRun(workspacePath: string, preflight: GitPreflight): Promise<GitPostflightInspection> {
    try {
      const branch = await this.currentBranch(workspacePath);
      const headSha = await this.currentHead(workspacePath);
      const workingTreeClean = await this.isClean(workspacePath);
      const currentUpstream = branch ? await this.currentUpstream(workspacePath, branch) : null;
      const upstreamUnchanged = currentUpstream?.remote === preflight.upstreamRemote && currentUpstream.ref === preflight.upstreamRef;

      // The preflight remote remains the only source of repository identity and remote proof.
      const originalRemoteExists = await this.remoteExists(workspacePath, preflight.upstreamRemote);
      const repository = originalRemoteExists
        ? (await this.repositoryForRemote(workspacePath, preflight.upstreamRemote)) ?? ""
        : preflight.repository;

      // Check ancestry before rev-list so replacement history cannot become an overflow error.
      const baseIsAncestor = await this.baseIsAncestor(workspacePath, preflight.baseSha, headSha);
      const commitShas = baseIsAncestor ? await this.commitsAfterBase(workspacePath, preflight.baseSha) : [];
      const remoteHeadSha = originalRemoteExists
        ? await this.strictRemoteHead(workspacePath, preflight.upstreamRemote, preflight.remoteBranchRef)
        : null;
      const pushVerified = upstreamUnchanged && remoteHeadSha === headSha;

      return {
        evidence: {
          githubRepository: repository,
          branch: branch ?? "",
          baseSha: preflight.baseSha,
          headSha,
          commitShas,
          workingTreeClean,
          upstreamRemote: preflight.upstreamRemote,
          upstreamRef: preflight.upstreamRef,
          remoteHeadSha,
          pushVerified,
        },
        baseIsAncestor,
        upstreamUnchanged,
      };
    } catch (error) {
      throw asWorkflowError(error, "GIT_INSPECTION_FAILED", "Git inspection failed");
    }
  }

  private async requireRepositoryRoot(workspacePath: string): Promise<void> {
    const root = line(await this.runner.run(workspacePath, ["rev-parse", "--show-toplevel"]));
    if ((await this.canonicalizePath(root)) !== workspacePath) throw new Error("Open workspace must be the Git repository root");
  }

  private async requireClean(workspacePath: string): Promise<void> {
    if (!(await this.isClean(workspacePath))) throw new Error("Git working tree must be clean, including untracked files");
  }

  private async isClean(workspacePath: string): Promise<boolean> {
    return (await this.runner.run(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"])).trim() === "";
  }

  private async currentBranch(workspacePath: string): Promise<string | null> {
    const branch = line(await this.runner.run(workspacePath, ["branch", "--show-current"]));
    return branch === "" ? null : branch;
  }

  private async currentHead(workspacePath: string): Promise<string> {
    const head = line(await this.runner.run(workspacePath, ["rev-parse", "HEAD"]));
    if (!FULL_OBJECT_ID.test(head)) throw new Error("Git HEAD is malformed");
    return head;
  }

  private async currentUpstream(workspacePath: string, branch: string): Promise<{ remote: string; ref: string } | null> {
    const output = await this.runner.run(workspacePath, [
      "for-each-ref",
      "--format=%(upstream:remotename)%09%(upstream:short)",
      `refs/heads/${branch}`,
    ]);
    const records = exactRecords(output);
    if (records.length !== 1) throw new Error("Git upstream is malformed");
    const fields = records[0].split("\t");
    if (fields.length !== 2) throw new Error("Git upstream is malformed");
    const [remote, ref] = fields;
    if (remote === "" && ref === "") return null;
    if (remote === "" || ref === "") throw new Error("Git upstream is malformed");
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) throw new Error("Git upstream is malformed");
    if (ref.slice(0, slash) !== remote || !isSafeRemoteName(remote) || !remoteRefForUpstream(ref, remote)) throw new Error("Git upstream is malformed");
    return { remote, ref };
  }

  private async repositoryForRemote(workspacePath: string, remote: string): Promise<string | null> {
    if (!isSafeRemoteName(remote)) throw new Error("Git remote name is invalid");
    return parseGitHubRepository(line(await this.runner.run(workspacePath, ["remote", "get-url", remote])));
  }

  private async remoteExists(workspacePath: string, expectedRemote: string): Promise<boolean> {
    if (!isSafeRemoteName(expectedRemote)) throw new Error("Git remote name is invalid");
    return lines(await this.runner.run(workspacePath, ["remote"])).includes(expectedRemote);
  }

  private async baseIsAncestor(workspacePath: string, baseSha: string, headSha: string): Promise<boolean> {
    if (baseSha === headSha) return true;
    if (this.runner.isAncestor) return this.runner.isAncestor(workspacePath, baseSha, headSha);
    const mergeBase = line(await this.runner.run(workspacePath, ["merge-base", baseSha, headSha]));
    if (!FULL_OBJECT_ID.test(mergeBase)) throw new Error("Git merge-base is malformed");
    return mergeBase === baseSha;
  }

  private async commitsAfterBase(workspacePath: string, baseSha: string): Promise<string[]> {
    const commits = lines(await this.runner.run(workspacePath, ["rev-list", "--reverse", `${baseSha}..HEAD`]));
    if (commits.length > MAX_COMMITS) throw new Error("Too many commits were created after the base SHA");
    if (commits.some((commit) => !FULL_OBJECT_ID.test(commit))) throw new Error("Git commit output is malformed");
    return commits;
  }

  private async strictRemoteHead(workspacePath: string, remote: string, remoteBranchRef: string): Promise<string | null> {
    if (!isSafeRemoteName(remote) || !isSafeRemoteBranchRef(remoteBranchRef)) throw new Error("Git remote target is invalid");
    const entries = lines(await this.runner.run(workspacePath, ["ls-remote", remote, remoteBranchRef]));
    if (entries.length === 0) return null;
    if (entries.length !== 1) throw new Error("Git remote response is malformed");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\t(refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/i.exec(entries[0]);
    if (!match || match[2] !== remoteBranchRef) throw new Error("Git remote response is malformed");
    return match[1];
  }
}

export function parseGitHubRepository(remoteUrl: string): string | null {
  const https = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/i.exec(remoteUrl);
  const ssh = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?$/i.exec(remoteUrl);
  const match = https ?? ssh;
  return match ? `${match[1]}/${match[2]}` : null;
}

export function isSafeRemoteName(value: string): boolean { return SAFE_REMOTE_NAME.test(value) && !value.startsWith("-"); }
export function isSafeRemoteBranchRef(value: string): boolean {
  return /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/.test(value) &&
    !value.includes("..") && !value.includes("//") && !value.endsWith(".") && !value.includes("@{");
}

function remoteRefForUpstream(upstreamRef: string, remote: string): string | null {
  if (!upstreamRef.startsWith(`${remote}/`)) return null;
  const branch = upstreamRef.slice(remote.length + 1);
  const result = `refs/heads/${branch}`;
  return isSafeRemoteBranchRef(result) ? result : null;
}
function line(value: string): string { return value.trim().split(/\r?\n/, 1)[0] ?? ""; }
function lines(value: string): string[] { return value.trim() === "" ? [] : value.trim().split(/\r?\n/).map((item) => item.trim()); }
function exactRecords(value: string): string[] {
  const withoutFinalNewline = value.replace(/(?:\r?\n)$/, "");
  return withoutFinalNewline === "" ? [] : withoutFinalNewline.split(/\r?\n/);
}
function boundedOutput(value: string): string { return value.length <= MAX_OUTPUT_BYTES ? value : value.slice(0, MAX_OUTPUT_BYTES); }
function asWorkflowError(error: unknown, code: "GIT_PREFLIGHT_FAILED" | "GIT_INSPECTION_FAILED", message: string): GitImplementationError {
  if (error instanceof GitImplementationError && error.code === code) return error;
  return new GitImplementationError(code, message);
}
