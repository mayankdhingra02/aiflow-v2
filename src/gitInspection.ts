import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { repositoryIdentityEquals, type GitDeliveryEvidence, type GitImplementationRunRequest } from "./gitImplementationContracts";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_COMMITS = 100;
const GIT_TIMEOUT_MS = 10_000;

export type GitInspectionErrorCode = "GIT_PREFLIGHT_FAILED" | "GIT_INSPECTION_FAILED" | "RUN_ACTIVE";

export class GitInspectionError extends Error {
  constructor(public readonly code: GitInspectionErrorCode, message: string) {
    super(singleLine(message));
    this.name = "GitInspectionError";
  }
}

export interface GitRunner {
  run(cwd: string, args: readonly string[]): Promise<string>;
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
    } catch (error) {
      // Do not include process diagnostics: Git can include credential-bearing remote URLs there.
      throw new GitInspectionError("GIT_INSPECTION_FAILED", "Git inspection command failed");
    }
  },
};

export interface GitPreflight {
  repository: string;
  branch: string;
  baseSha: string;
  upstreamRemote: string;
  upstreamRef: string;
}

export class GitInspection {
  constructor(private readonly runner: GitRunner = systemGitRunner) {}

  async preflight(workspacePath: string, request: GitImplementationRunRequest): Promise<GitPreflight> {
    try {
      const root = line(await this.runner.run(workspacePath, ["rev-parse", "--show-toplevel"]));
      if (root !== workspacePath) {
        throw new Error("Open workspace must be the Git repository root");
      }
      if ((await this.runner.run(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"])).trim() !== "") {
        throw new Error("Git working tree must be clean, including untracked files");
      }
      const branch = line(await this.runner.run(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
      if (branch !== request.expectedBranch) {
        throw new Error("Current Git branch does not match the expected branch");
      }
      const baseSha = line(await this.runner.run(workspacePath, ["rev-parse", "HEAD"]));
      if (baseSha !== request.expectedBaseSha) {
        throw new Error("Current Git HEAD does not match the expected base SHA");
      }
      await this.runner.run(workspacePath, ["rev-parse", "--verify", `${request.expectedBaseSha}^{object}`]);
      const upstreamRef = line(await this.runner.run(workspacePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
      const slash = upstreamRef.indexOf("/");
      if (slash <= 0 || slash === upstreamRef.length - 1) {
        throw new Error("Current Git branch must have an upstream remote branch");
      }
      const upstreamRemote = upstreamRef.slice(0, slash);
      const remoteUrl = line(await this.runner.run(workspacePath, ["remote", "get-url", upstreamRemote]));
      const repository = parseGitHubRepository(remoteUrl);
      if (!repository || !repositoryIdentityEquals(repository, request.expectedGitHubRepository)) {
        throw new Error("GitHub repository does not match the expected repository");
      }
      return { repository, branch, baseSha, upstreamRemote, upstreamRef };
    } catch (error) {
      if (error instanceof GitInspectionError) {
        throw error;
      }
      throw new GitInspectionError("GIT_PREFLIGHT_FAILED", safeError(error, "Git preflight failed"));
    }
  }

  async snapshot(workspacePath: string): Promise<GitPreflight> {
    try {
      const root = line(await this.runner.run(workspacePath, ["rev-parse", "--show-toplevel"]));
      if (root !== workspacePath) throw new Error("Open workspace must be the Git repository root");
      if ((await this.runner.run(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"])).trim() !== "") {
        throw new Error("Git working tree must be clean, including untracked files");
      }
      const branch = line(await this.runner.run(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
      const baseSha = line(await this.runner.run(workspacePath, ["rev-parse", "HEAD"]));
      const upstreamRef = line(await this.runner.run(workspacePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
      const slash = upstreamRef.indexOf("/");
      if (slash <= 0 || slash === upstreamRef.length - 1) throw new Error("Current Git branch must have an upstream remote branch");
      const upstreamRemote = upstreamRef.slice(0, slash);
      const repository = parseGitHubRepository(line(await this.runner.run(workspacePath, ["remote", "get-url", upstreamRemote])));
      if (!repository) throw new Error("Git remote is not a recognized GitHub repository");
      return { repository, branch, baseSha, upstreamRemote, upstreamRef };
    } catch (error) {
      if (error instanceof GitInspectionError) throw error;
      throw new GitInspectionError("GIT_PREFLIGHT_FAILED", safeError(error, "Git preflight failed"));
    }
  }

  async inspectAfterRun(workspacePath: string, preflight: GitPreflight): Promise<GitDeliveryEvidence> {
    try {
      const branch = line(await this.runner.run(workspacePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
      const headSha = line(await this.runner.run(workspacePath, ["rev-parse", "HEAD"]));
      const dirty = (await this.runner.run(workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"])).trim() !== "";
      const upstreamRef = line(await this.runner.run(workspacePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
      const slash = upstreamRef.indexOf("/");
      if (slash <= 0 || slash === upstreamRef.length - 1) throw new Error("Current Git branch has no upstream");
      const upstreamRemote = upstreamRef.slice(0, slash);
      const remoteUrl = line(await this.runner.run(workspacePath, ["remote", "get-url", upstreamRemote]));
      const repository = parseGitHubRepository(remoteUrl);
      if (!repository) throw new Error("Git remote is not a recognized GitHub repository");
      const commits = lines(await this.runner.run(workspacePath, ["rev-list", "--reverse", `${preflight.baseSha}..HEAD`]));
      if (commits.length > MAX_COMMITS) throw new Error("Too many commits were created after the base SHA");
      const remoteBranch = upstreamRef.slice(slash + 1);
      const remoteOutput = await this.runner.run(workspacePath, ["ls-remote", upstreamRemote, `refs/heads/${remoteBranch}`]);
      const remoteHeadSha = remoteOutput.trim() === "" ? null : line(remoteOutput).split(/\s+/)[0] ?? null;
      return {
        githubRepository: repository,
        branch,
        baseSha: preflight.baseSha,
        headSha,
        commitShas: commits,
        workingTreeClean: !dirty,
        upstreamRemote,
        upstreamRef,
        remoteHeadSha,
        pushVerified: remoteHeadSha === headSha,
      };
    } catch (error) {
      if (error instanceof GitInspectionError) throw error;
      throw new GitInspectionError("GIT_INSPECTION_FAILED", safeError(error, "Git inspection failed"));
    }
  }

  async isBaseAncestor(workspacePath: string, baseSha: string, headSha: string): Promise<boolean> {
    try {
      await this.runner.run(workspacePath, ["merge-base", "--is-ancestor", baseSha, headSha]);
      return true;
    } catch {
      return false;
    }
  }
}

export function parseGitHubRepository(remoteUrl: string): string | null {
  const https = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/i.exec(remoteUrl);
  const ssh = /^git@github\.com:([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?$/i.exec(remoteUrl);
  const match = https ?? ssh;
  return match ? `${match[1]}/${match[2]}` : null;
}

function line(value: string): string { return value.trim().split(/\r?\n/, 1)[0] ?? ""; }
function lines(value: string): string[] { return value.trim() === "" ? [] : value.trim().split(/\r?\n/).map((item) => item.trim()); }
function boundedOutput(value: string): string { return value.length <= MAX_OUTPUT_BYTES ? value : value.slice(0, MAX_OUTPUT_BYTES); }
function singleLine(value: string): string { return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 400); }
function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/(?:https?:\/\/|git@)[^\s]+/gi, "[redacted remote]");
}
