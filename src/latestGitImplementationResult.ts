import type { GitImplementationRunResult } from "./gitImplementationContracts";

/** Volatile, deliberately single-entry result handoff. */
export class LatestGitImplementationResultStore {
  private latest: GitImplementationRunResult | null = null;

  replace(result: GitImplementationRunResult): void { this.latest = clone(result); }
  get(): GitImplementationRunResult | null { return this.latest ? clone(this.latest) : null; }
  clear(): void { this.latest = null; }
}

function clone(result: GitImplementationRunResult): GitImplementationRunResult {
  return {
    ...result,
    codex: { ...result.codex },
    git: { ...result.git, commitShas: [...result.git.commitShas] },
  };
}
