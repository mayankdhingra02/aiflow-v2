import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createImplementationReviewEnvelope,
  serializeImplementationReviewEnvelope,
  validateGitImplementationRunRequest,
  type GitImplementationRunRequest,
} from "../src/gitImplementationContracts";
import { GitInspection, GitInspectionError, parseGitHubRepository, type GitRunner } from "../src/gitInspection";
import { GitImplementationCommandController, type GitImplementationCommandUi, type GitImplementationRunService } from "../src/gitImplementationCommands";
import { GitImplementationService } from "../src/gitImplementationService";
import type { OfficialCodexRunResult } from "../src/officialCodexContracts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const WORKSPACE = "/workspace";

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
    await assert.rejects(service.run(requestFor()), GitInspectionError);
    assert.equal(official.requests.length, 0, mutation);
  }
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

test("post-run inspection failure is deterministic and remote URLs never enter errors", async () => {
  const official = new FakeOfficial();
  const runner = new FixtureGitRunner("timeout");
  const service = makeGitService(official, runner);
  const result = await service.run(requestFor());
  assert.equal(result.deliveryStatus, "git_inspection_failed");
  await assert.rejects(new GitInspection(new FixtureGitRunner("repository")).preflight(WORKSPACE, requestFor()), (error: unknown) => {
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

test("concurrent Git implementation execution is rejected at the service boundary", async () => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const official = new FakeOfficial();
  official.wait = waiting;
  const service = makeGitService(official, new FixtureGitRunner());
  const first = service.run(requestFor());
  await assert.rejects(service.run(requestFor("second")), GitInspectionError);
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
  await assert.rejects(controller.runProgrammatic({}), /Official Codex run request/);
});

type FixtureMutation = "normal" | "dirty" | "detached" | "branch" | "base" | "repository" | "upstream" | "no-commit" | "rewritten" | "post-branch" | "post-dirty" | "remote-mismatch" | "timeout";

class FixtureGitRunner implements GitRunner {
  private preflightComplete = false;
  constructor(private readonly mutation: FixtureMutation = "normal") {}

  async run(_cwd: string, args: readonly string[]): Promise<string> {
    const command = args.join(" ");
    const post = this.preflightComplete;
    if (this.mutation === "timeout" && post && command.startsWith("ls-remote")) throw new Error("timed out https://secret@github.com/owner/repository.git");
    if (command === "rev-parse --show-toplevel") return `${WORKSPACE}\n`;
    if (command.startsWith("status")) return this.mutation === "dirty" || (post && this.mutation === "post-dirty") ? "?? untracked\n" : "";
    if (command === "symbolic-ref --quiet --short HEAD") {
      if (this.mutation === "detached") throw new Error("detached");
      return `${post && this.mutation === "post-branch" ? "other" : this.mutation === "branch" ? "wrong" : "main"}\n`;
    }
    if (command === "rev-parse HEAD") return `${this.mutation === "base" && !post ? HEAD : post ? HEAD : BASE}\n`;
    if (command.startsWith("rev-parse --verify")) return `${BASE}\n`;
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") {
      if (this.mutation === "upstream") throw new Error("no upstream");
      return "origin/main\n";
    }
    if (command === "remote get-url origin") {
      const result = this.mutation === "repository" ? "https://secret@github.com/other/repo.git\n" : "https://github.com/Owner/repository.git\n";
      this.preflightComplete = true;
      return result;
    }
    if (command.startsWith("rev-list")) return this.mutation === "no-commit" ? "" : `${HEAD}\n`;
    if (command.startsWith("ls-remote")) return this.mutation === "remote-mismatch" ? `${BASE}\trefs/heads/main\n` : `${HEAD}\trefs/heads/main\n`;
    if (command.startsWith("merge-base")) {
      if (this.mutation === "rewritten") throw new Error("not ancestor");
      return "";
    }
    throw new Error(`unexpected fixed git command: ${command}`);
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
  async snapshot() { return { repository: "Owner/repository", branch: "main", baseSha: BASE, upstreamRemote: "origin", upstreamRef: "origin/main" }; }
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
  return new GitImplementationService(official, new GitInspection(runner), async (workspacePath) => workspacePath);
}
