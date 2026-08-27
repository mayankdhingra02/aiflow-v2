import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  createImplementationReviewEnvelope,
  GitImplementationError,
  serializeImplementationReviewEnvelope,
  validateImplementationReviewEnvelope,
  validateGitImplementationRunRequest,
  type GitImplementationRunRequest,
} from "../src/gitImplementationContracts";
import { reviewEnvelopeSha256 } from "../src/browserBridgeProtocol";
import { GitInspection, isSafeRemoteName, parseGitHubRepository, type GitRunner } from "../src/gitInspection";
import { GitImplementationCommandController, type GitImplementationCommandUi, type GitImplementationRunService } from "../src/gitImplementationCommands";
import { GitImplementationService } from "../src/gitImplementationService";
import type { OfficialCodexRunResult } from "../src/officialCodexContracts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const WORKSPACE = "/workspace";
const execFileAsync = promisify(execFile);

test("GitHub HTTPS and SSH parsing returns only safe repository identities", () => {
  assert.equal(parseGitHubRepository("https://github.com/Owner/repository.git"), "Owner/repository");
  assert.equal(parseGitHubRepository("git@github.com:Owner/repository.git"), "Owner/repository");
  assert.equal(parseGitHubRepository("https://credential@github.com/Owner/repository.git"), null);
  assert.equal(parseGitHubRepository("https://example.com/Owner/repository.git"), null);
});

test("request contract preserves Phase 2 validation and validates Git fields", () => {
  const request = requestFor();
  validateGitImplementationRunRequest(request);
  assert.throws(() => validateGitImplementationRunRequest({ ...request, expectedGitHubRepository: "owner/repo; rm" }));
  assert.throws(() => validateGitImplementationRunRequest({ ...request, expectedBaseSha: "short" }));
  assert.throws(() => validateGitImplementationRunRequest({ ...request, expectedBranch: "" }));
});

test("preflight rejects dirty, untracked, detached, branch/base/repository and upstream failures before Codex", async () => {
  for (const mutation of ["dirty", "detached", "branch", "base", "repository", "upstream"] as const) {
    const runner = new FixtureGitRunner(mutation);
    const official = new FakeOfficial();
    const service = makeGitService(official, runner);
    await assert.rejects(service.run(requestFor()), GitImplementationError);
    assert.equal(official.requests.length, 0, mutation);
  }
});

test("real local Git discovers a configured branch upstream without contacting its remote", async () => {
  const repositoryPath = await fs.mkdtemp(path.join(os.tmpdir(), "aiflow-git-inspection-"));
  try {
    await git(repositoryPath, ["init", "-b", "main"]);
    await git(repositoryPath, ["config", "user.email", "test@example.invalid"]);
    await git(repositoryPath, ["config", "user.name", "Aiflow Test"]);
    await fs.writeFile(path.join(repositoryPath, "README.txt"), "tracked\n");
    await git(repositoryPath, ["add", "README.txt"]);
    await git(repositoryPath, ["commit", "-m", "initial"]);
    await git(repositoryPath, ["remote", "add", "origin", "https://github.com/Owner/repository.git"]);
    await git(repositoryPath, ["config", "branch.main.remote", "origin"]);
    await git(repositoryPath, ["config", "branch.main.merge", "refs/heads/main"]);

    const canonicalRepositoryPath = await fs.realpath(repositoryPath);
    const snapshot = await new GitInspection().snapshot(canonicalRepositoryPath);
    assert.deepEqual(snapshot, {
      repository: "Owner/repository", branch: "main", baseSha: await git(repositoryPath, ["rev-parse", "HEAD"]),
      upstreamRemote: "origin", upstreamRef: "origin/main", remoteBranchRef: "refs/heads/main",
    });

    await git(repositoryPath, ["config", "--unset", "branch.main.remote"]);
    await assert.rejects(new GitInspection().snapshot(canonicalRepositoryPath), (error: unknown) => {
      assert.ok(error instanceof GitImplementationError);
      assert.equal((error as GitImplementationError).code, "GIT_PREFLIGHT_FAILED");
      return true;
    });
  } finally {
    await fs.rm(repositoryPath, { recursive: true, force: true });
  }
});

test("upstream discovery queries the exact branch ref, including branch names with slashes", async () => {
  const runner = new FixtureGitRunner("branch-slash");
  const request = { ...requestFor(), expectedBranch: "feature/phase3" };
  const preflight = await new GitInspection(runner, async (value) => value).preflight(WORKSPACE, request);
  assert.deepEqual(runner.upstreamArgs, [
    "for-each-ref",
    "--format=%(upstream:remotename)%09%(upstream:short)",
    "refs/heads/feature/phase3",
  ]);
  assert.equal(preflight.upstreamRef, "origin/feature/phase3");
  assert.equal(preflight.remoteBranchRef, "refs/heads/feature/phase3");
});

test("exact implementation prompt is preserved and completed run verifies commit and push", async () => {
  const official = new FakeOfficial();
  const service = makeGitService(official, new FixtureGitRunner());
  const request = requestFor(" exact\nimplementation prompt 🙂 ");
  const result = await service.run(request);
  assert.equal(official.requests[0].prompt, request.prompt);
  assert.equal(result.deliveryStatus, "verified");
  assert.deepEqual(result.git.commitShas, [HEAD]);
  assert.equal(result.git.remoteHeadSha, HEAD);
  assert.equal(result.git.pushVerified, true);
});

test("delivery status precedence covers no commit, rewritten history, branch, dirty, remote and Codex outcomes", async () => {
  const cases: Array<[FixtureMutation, "completed" | "failed" | "cancelled", string]> = [
    ["no-commit", "completed", "no_commit"],
    ["rewritten", "completed", "history_rewritten"],
    ["post-branch", "completed", "branch_changed"],
    ["post-dirty", "completed", "working_tree_dirty"],
    ["remote-mismatch", "completed", "push_not_verified"],
    ["normal", "cancelled", "codex_not_completed"],
    ["normal", "failed", "codex_not_completed"],
  ];
  for (const [mutation, outcome, expected] of cases) {
    const official = new FakeOfficial(outcome);
    const service = makeGitService(official, new FixtureGitRunner(mutation));
    assert.equal((await service.run(requestFor())).deliveryStatus, expected, `${mutation}/${outcome}`);
  }
});

test("preflight upstream target remains authoritative when Codex changes, removes, or redirects upstream", async () => {
  for (const mutation of ["upstream-branch", "upstream-remote", "upstream-removed"] as const) {
    const runner = new FixtureGitRunner(mutation);
    const result = await makeGitService(new FakeOfficial(), runner).run(requestFor());
    assert.equal(result.deliveryStatus, "push_not_verified", mutation);
    assert.equal(runner.lsRemoteCalls, 0, mutation);
    assert.equal(result.git.upstreamRemote, "origin");
    assert.equal(result.git.upstreamRef, "origin/main");
  }
});

test("remote verification is skipped for every higher-precedence delivery status", async () => {
  for (const outcome of ["failed", "cancelled"] as const) {
    const runner = new FixtureGitRunner("normal", true);
    const result = await makeGitService(new FakeOfficial(outcome), runner).run(requestFor());
    assert.equal(result.deliveryStatus, "codex_not_completed", outcome);
    assert.equal(runner.lsRemoteCalls, 0, outcome);
  }
  const cases: Array<[FixtureMutation, string]> = [
    ["post-repository", "repository_mismatch"],
    ["post-branch", "branch_changed"],
    ["post-detached", "branch_changed"],
    ["rewritten", "history_rewritten"],
    ["no-commit", "no_commit"],
    ["post-dirty", "working_tree_dirty"],
    ["upstream-branch", "push_not_verified"],
    ["upstream-removed", "push_not_verified"],
  ];
  for (const [mutation, expected] of cases) {
    const runner = new FixtureGitRunner(mutation, true);
    const result = await makeGitService(new FakeOfficial(), runner).run(requestFor());
    assert.equal(result.deliveryStatus, expected, mutation);
    assert.equal(result.git.remoteHeadSha, null, mutation);
    assert.equal(result.git.pushVerified, false, mutation);
    assert.equal(runner.lsRemoteCalls, 0, mutation);
  }
});

test("remote proof runs exactly once only after local gates pass", async () => {
  const verifiedRunner = new FixtureGitRunner();
  assert.equal((await makeGitService(new FakeOfficial(), verifiedRunner).run(requestFor())).deliveryStatus, "verified");
  assert.equal(verifiedRunner.lsRemoteCalls, 1);
  for (const mutation of ["remote-empty", "remote-mismatch"] as const) {
    const runner = new FixtureGitRunner(mutation);
    assert.equal((await makeGitService(new FakeOfficial(), runner).run(requestFor())).deliveryStatus, "push_not_verified");
    assert.equal(runner.lsRemoteCalls, 1);
  }
  for (const mutation of ["timeout", "remote-malformed-sha", "remote-wrong-ref", "remote-duplicate"] as const) {
    const runner = new FixtureGitRunner(mutation);
    assert.equal((await makeGitService(new FakeOfficial(), runner).run(requestFor())).deliveryStatus, "git_inspection_failed");
    assert.equal(runner.lsRemoteCalls, 1);
  }
});

test("detached post-run HEAD and rewritten replacement history fail closed before commit enumeration", async () => {
  const detached = await makeGitService(new FakeOfficial(), new FixtureGitRunner("post-detached")).run(requestFor());
  assert.equal(detached.deliveryStatus, "branch_changed");
  const runner = new FixtureGitRunner("rewritten");
  const rewritten = await makeGitService(new FakeOfficial(), runner).run(requestFor());
  assert.equal(rewritten.deliveryStatus, "history_rewritten");
  assert.equal(runner.revListCalls, 0);
});

test("divergent and unrelated replacement histories are history_rewritten", async () => {
  for (const mutation of ["divergent", "orphan"] as const) {
    const result = await makeGitService(new FakeOfficial(), new FixtureGitRunner(mutation)).run(requestFor());
    assert.equal(result.deliveryStatus, "history_rewritten", mutation);
  }
});

test("ls-remote accepts only one exact full SHA/ref response", async () => {
  const valid = await makeGitService(new FakeOfficial(), new FixtureGitRunner()).run(requestFor());
  assert.equal(valid.git.remoteHeadSha, HEAD);
  const empty = await makeGitService(new FakeOfficial(), new FixtureGitRunner("remote-empty")).run(requestFor());
  assert.equal(empty.deliveryStatus, "push_not_verified");
  assert.equal(empty.git.remoteHeadSha, null);
  for (const mutation of ["remote-malformed-sha", "remote-wrong-ref", "remote-duplicate"] as const) {
    const result = await makeGitService(new FakeOfficial(), new FixtureGitRunner(mutation)).run(requestFor());
    assert.equal(result.deliveryStatus, "git_inspection_failed", mutation);
  }
});

test("remote-name validation and canonical root comparison are conservative", async () => {
  assert.equal(isSafeRemoteName("origin"), true);
  assert.equal(isSafeRemoteName("-origin"), false);
  assert.equal(isSafeRemoteName("origin;rm"), false);
  const fixture = new FixtureGitRunner();
  const inspection = new GitInspection(
    { run: async (cwd, args) => args.join(" ") === "rev-parse --show-toplevel" ? "/tmp/workspace\n" : fixture.run(cwd, args) },
    async (value) => value === "/tmp/workspace" ? "/private/tmp/workspace" : value,
  );
  const request = { ...requestFor(), workspacePath: "/private/tmp/workspace" };
  await inspection.preflight(request.workspacePath, request);
});

test("Git workflow errors are typed and omit prompt, URLs, credentials, and paths", async () => {
  const prompt = "DO-NOT-LEAK-this-complete-prompt";
  const invalid = makeGitService(new FakeOfficial(), new FixtureGitRunner());
  await assert.rejects(invalid.run({ ...requestFor(prompt), expectedBaseSha: "bad" }), (error: unknown) => {
    assert.ok(error instanceof GitImplementationError);
    assert.equal((error as Error).message.includes(prompt), false);
    return true;
  });
  const preflight = makeGitService(new FakeOfficial(), new FixtureGitRunner("repository"));
  await assert.rejects(preflight.run(requestFor(prompt)), (error: unknown) => {
    assert.ok(error instanceof GitImplementationError);
    assert.equal(String(error).includes("secret"), false);
    assert.equal(String(error).includes(prompt), false);
    return true;
  });
});

test("post-run inspection failure is deterministic and remote URLs never enter errors", async () => {
  const official = new FakeOfficial();
  const runner = new FixtureGitRunner("timeout");
  const service = makeGitService(official, runner);
  const result = await service.run(requestFor());
  assert.equal(result.deliveryStatus, "git_inspection_failed");
  await assert.rejects(new GitInspection(new FixtureGitRunner("repository"), async (path) => path).preflight(WORKSPACE, requestFor()), (error: unknown) => {
    assert.equal(String(error).includes("secret"), false);
    return true;
  });
});

test("review envelope serialization is deterministic and excludes local workspace, remote URL, and prompt", async () => {
  const service = makeGitService(new FakeOfficial(), new FixtureGitRunner());
  const result = await service.run(requestFor("do not serialize this prompt"));
  const serialized = serializeImplementationReviewEnvelope(createImplementationReviewEnvelope(result));
  assert.equal(serialized, serializeImplementationReviewEnvelope(createImplementationReviewEnvelope(result)));
  assert.equal(serialized.includes(WORKSPACE), false);
  assert.equal(serialized.includes("github.com"), false);
  assert.equal(serialized.includes("do not serialize this prompt"), false);
});

test("review envelope accepts UUIDv7 Official Codex correlations without loosening local run IDs", () => {
  const result = { runId: "00000000-0000-4000-8000-000000000001", deliveryStatus: "verified", codex: { outcome: "completed", finalResponse: "done", requestedModelRole: "terra", requestedModelId: "gpt-5.6-codex", requestedReasoningEffort: "medium", recordedModelId: null, recordedReasoningEffort: null, conversationId: "01a04025-4a6c-78d3-a1b1-eeb401a868f1", turnId: "01a04025-67bd-7bb2-b2be-9eae0e010db3", startedAt: "2026-08-26T12:00:00.000Z", finishedAt: "2026-08-26T12:00:00.000Z" }, git: { githubRepository: "Owner/repository", branch: "main", baseSha: "a".repeat(40), headSha: "b".repeat(40), commitShas: [], pushVerified: true, workingTreeClean: true, upstreamRemote: "origin", upstreamRef: "origin/main", remoteHeadSha: "b".repeat(40) } } as any;
  const envelope = createImplementationReviewEnvelope(result);
  assert.doesNotThrow(() => validateImplementationReviewEnvelope(envelope));
  assert.equal(envelope.conversationId, result.codex.conversationId); assert.equal(envelope.turnId, result.codex.turnId);
  const serialized = serializeImplementationReviewEnvelope(envelope);
  assert.equal(serialized, serializeImplementationReviewEnvelope(envelope));
  assert.equal(reviewEnvelopeSha256(envelope), reviewEnvelopeSha256(envelope));
  const v4 = { ...envelope, conversationId: "00000000-0000-4000-8000-000000000003", turnId: "00000000-0000-4000-8000-000000000004" };
  assert.doesNotThrow(() => validateImplementationReviewEnvelope(v4));
  for (const value of ["01a04025-4a6c-08d3-a1b1-eeb401a868f1", "01a04025-4a6c-78d3-71b1-eeb401a868f1", "00000000-0000-0000-0000-000000000000", "x01a04025-4a6c-78d3-a1b1-eeb401a868f1", "01a04025-4a6c-78d3-a1b1-eeb401a868f1x", " 01a04025-4a6c-78d3-a1b1-eeb401a868f1", "01a04025-4a6c-78d3-a1b1-eeb401a868fg"]) {
    assert.throws(() => validateImplementationReviewEnvelope({ ...envelope, conversationId: value }));
  }
  assert.throws(() => validateImplementationReviewEnvelope({ ...envelope, runId: "01a04025-4a6c-78d3-a1b1-eeb401a868f1" }));
});

test("concurrent Git implementation execution is rejected at the service boundary", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const official = new FakeOfficial();
  official.wait = waiting;
  const service = makeGitService(official, new FixtureGitRunner());
  const first = service.run(requestFor());
  await assert.rejects(service.run(requestFor("second")), GitImplementationError);
  release();
  await first;
});

test("Git clipboard command uses the shared service, preserves the exact prompt, and cancellation starts zero runs", async () => {
  const service = new FakeGitCommandService();
  const ui = new FakeGitUi();
  ui.clipboard = " exact\nclipboard implementation 🙂 ";
  const controller = new GitImplementationCommandController(service, ui);
  const result = await controller.runClipboard();
  assert.ok(result);
  assert.equal(service.requests[0].prompt, ui.clipboard);
  assert.equal(service.requests[0].expectedGitHubRepository, "Owner/repository");
  assert.equal(ui.details?.promptBytes, Buffer.byteLength(ui.clipboard));
  ui.confirm = false;
  await controller.runClipboard();
  assert.equal(service.requests.length, 1);
  await assert.rejects(controller.runProgrammatic({}), GitImplementationError);
});

type FixtureMutation = "normal" | "dirty" | "detached" | "branch" | "branch-slash" | "base" | "repository" | "upstream" | "no-commit" | "rewritten" | "divergent" | "orphan" | "post-branch" | "post-detached" | "post-dirty" | "post-repository" | "upstream-branch" | "upstream-remote" | "upstream-removed" | "remote-mismatch" | "remote-empty" | "remote-malformed-sha" | "remote-wrong-ref" | "remote-duplicate" | "timeout";

class FixtureGitRunner implements GitRunner {
  private preflightComplete = false;
  lsRemoteArgs: string[] | undefined;
  lsRemoteCalls = 0;
  upstreamArgs: string[] | undefined;
  revListCalls = 0;
  constructor(private readonly mutation: FixtureMutation = "normal", private readonly failOnLsRemote = false) {}

  async run(_cwd: string, args: readonly string[]): Promise<string> {
    const command = args.join(" ");
    const post = this.preflightComplete;
    if (command === "rev-parse --show-toplevel") return `${WORKSPACE}\n`;
    if (command.startsWith("status")) return this.mutation === "dirty" || (post && this.mutation === "post-dirty") ? "?? untracked\n" : "";
    if (command === "branch --show-current") {
      if (this.mutation === "detached" || (post && this.mutation === "post-detached")) return "";
      return `${post && this.mutation === "post-branch" ? "other" : this.mutation === "branch" ? "wrong" : this.mutation === "branch-slash" ? "feature/phase3" : "main"}\n`;
    }
    if (command === "rev-parse HEAD") return `${this.mutation === "base" && !post ? HEAD : post ? HEAD : BASE}\n`;
    if (command.startsWith("rev-parse --verify")) return `${BASE}\n`;
    if (args[0] === "for-each-ref") {
      this.upstreamArgs = [...args];
      assert.equal(args[2].includes("HEAD"), false);
      const branchRef = args[2];
      if (this.mutation === "upstream") return "\t\n";
      if (post && this.mutation === "upstream-branch") return "origin\torigin/other\n";
      if (post && this.mutation === "upstream-remote") return "other\tother/main\n";
      if (post && this.mutation === "upstream-removed") return "\t\n";
      if (branchRef === "refs/heads/other") return "origin\torigin/other\n";
      if (branchRef === "refs/heads/feature/phase3") return "origin\torigin/feature/phase3\n";
      return "origin\torigin/main\n";
    }
    if (command === "remote get-url origin") {
      const result = this.mutation === "repository" ? "https://secret@github.com/other/repo.git\n"
        : post && this.mutation === "post-repository" ? "https://github.com/other/repository.git\n"
          : "https://github.com/Owner/repository.git\n";
      if (!post) this.preflightComplete = true;
      return result;
    }
    if (command === "remote") return "origin\nother\n";
    if (command.startsWith("rev-list")) { this.revListCalls += 1; return this.mutation === "no-commit" ? "" : `${HEAD}\n`; }
    if (command.startsWith("ls-remote")) {
      this.lsRemoteArgs = [...args];
      this.lsRemoteCalls += 1;
      if (this.failOnLsRemote) throw new Error("remote verification should not run");
      if (this.mutation === "timeout" && post) throw new Error("timed out https://secret@github.com/owner/repository.git");
      if (this.mutation === "remote-empty") return "";
      if (this.mutation === "remote-malformed-sha") return `not-a-sha\trefs/heads/main\n`;
      if (this.mutation === "remote-wrong-ref") return `${HEAD}\trefs/heads/other\n`;
      if (this.mutation === "remote-duplicate") return `${HEAD}\trefs/heads/main\n${HEAD}\trefs/heads/main\n`;
      return this.mutation === "remote-mismatch" ? `${BASE}\trefs/heads/main\n` : `${HEAD}\trefs/heads/main\n`;
    }
    if (command.startsWith("merge-base")) {
      if (this.mutation === "rewritten") return `${"c".repeat(40)}\n`;
      return `${BASE}\n`;
    }
    throw new Error(`unexpected fixed git command: ${command}`);
  }

  async isAncestor(_cwd: string, _baseSha: string, _headSha: string): Promise<boolean> {
    if (this.mutation === "rewritten" || this.mutation === "divergent" || this.mutation === "orphan") return false;
    return true;
  }
}

class FakeOfficial {
  requests: GitImplementationRunRequest[] = [];
  wait: Promise<void> | undefined;
  constructor(private readonly outcome: "completed" | "failed" | "cancelled" = "completed") {}
  async run(argument: unknown): Promise<OfficialCodexRunResult> {
    const request = argument as GitImplementationRunRequest;
    this.requests.push(request);
    await this.wait;
    return {
      runId: request.runId, conversationId: "conversation", turnId: "turn", outcome: this.outcome,
      finalResponse: "done", requestedModelRole: request.modelRole, requestedModelId: "gpt-5.6-luna",
      requestedReasoningEffort: request.reasoningEffort, recordedModelId: "gpt-5.6-luna",
      recordedReasoningEffort: request.reasoningEffort, startedAt: "2026-08-23T00:00:00.000Z", finishedAt: "2026-08-23T00:00:01.000Z",
    };
  }
  async cancel(): Promise<"none"> { return "none"; }
}

class FakeGitCommandService implements GitImplementationRunService {
  requests: GitImplementationRunRequest[] = [];
  async snapshot() { return { repository: "Owner/repository", branch: "main", baseSha: BASE, upstreamRemote: "origin", upstreamRef: "origin/main", remoteBranchRef: "refs/heads/main" }; }
  async run(argument: unknown) {
    const request = argument as GitImplementationRunRequest;
    this.requests.push(request);
    return {
      runId: request.runId, deliveryStatus: "verified" as const,
      codex: await new FakeOfficial().run(request),
      git: { githubRepository: "Owner/repository", branch: "main", baseSha: BASE, headSha: HEAD, commitShas: [HEAD], workingTreeClean: true, upstreamRemote: "origin", upstreamRef: "origin/main", remoteHeadSha: HEAD, pushVerified: true },
    };
  }
}

class FakeGitUi implements GitImplementationCommandUi {
  clipboard = "clipboard";
  confirm = true;
  details: { promptBytes: number } | undefined;
  async readClipboardText() { return this.clipboard; }
  async chooseModelRole() { return "terra" as const; }
  async chooseReasoningEffort() { return "high" as const; }
  async getOpenCanonicalWorkspace() { return WORKSPACE; }
  async confirmRun() { return true; }
  async confirmGitImplementation(details: { promptBytes: number }) { this.details = details; return this.confirm; }
  appendOutput() {}
  showError() {}
}

function requestFor(prompt = "implement this exactly"): GitImplementationRunRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000123", workspacePath: WORKSPACE, prompt,
    modelRole: "luna", reasoningEffort: "low", expectedGitHubRepository: "owner/repository",
    expectedBranch: "main", expectedBaseSha: BASE,
  };
}

function makeGitService(official: FakeOfficial, runner: GitRunner): GitImplementationService {
  return new GitImplementationService(official, new GitInspection(runner, async (value) => value), async (workspacePath) => workspacePath);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, shell: false });
  return result.stdout.trim();
}
