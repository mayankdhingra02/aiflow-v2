import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import type { OfficialCodexRunRequest, OfficialCodexRunResult } from "../src/officialCodexContracts";
import {
  OfficialCodexError,
  OfficialCodexExecutionService,
  createWorkspaceAuthorizer,
  type OfficialCodexRunExecutor,
  type OfficialExtensionResolver,
  type WorkspaceResolver,
} from "../src/officialCodexService";

test("service requires the exact one canonical open workspace before invoking its worker", async () => {
  await withWorkspaces(async ({ workspace, alias, other }) => {
    const worker = new FakeWorker();
    const resolver = workspaceResolver(alias);
    const service = new OfficialCodexExecutionService(worker, resolver, extensionResolver());
    assert.equal(service.worker, worker);
    const request = makeRequest(workspace);

    const result = await service.run(request);
    assert.equal(worker.requests.length, 1);
    assert.equal(worker.requests[0].workspacePath, workspace);
    assert.equal(result.runId, request.runId);

    await assert.rejects(service.run(makeRequest(other)), (error: unknown) => {
      assert.equal((error as OfficialCodexError).code, "WORKSPACE_MISMATCH");
      return true;
    });
    assert.equal(worker.requests.length, 1);
  });
});

test("service rejects multiple workspaces and an unsupported official extension before bootstrap", async () => {
  await withWorkspaces(async ({ workspace, other }) => {
    const worker = new FakeWorker();
    const multiple = new OfficialCodexExecutionService(
      worker,
      { getWorkspaceFolders: async () => [{ scheme: "file", path: workspace }, { scheme: "file", path: other }] },
      extensionResolver(),
    );
    await assert.rejects(multiple.run(makeRequest(workspace)), (error: unknown) => {
      assert.equal((error as OfficialCodexError).code, "WORKSPACE_INVALID");
      return true;
    });

    const badVersion = new OfficialCodexExecutionService(
      worker,
      workspaceResolver(workspace),
      extensionResolver("26.814.41408"),
    );
    await assert.rejects(badVersion.run(makeRequest(workspace)), (error: unknown) => {
      assert.equal((error as OfficialCodexError).code, "EXTENSION_VERSION");
      return true;
    });
    assert.equal(worker.requests.length, 0);
  });
});

test("workspace authorizer is reusable by the worker and rejects arbitrary paths", async () => {
  await withWorkspaces(async ({ workspace, other }) => {
    const authorize = createWorkspaceAuthorizer(workspaceResolver(workspace));
    assert.equal(await authorize(workspace), workspace);
    await assert.rejects(authorize(other), /does not match/);
  });
});

function makeRequest(workspacePath: string): OfficialCodexRunRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000123",
    workspacePath,
    prompt: "safe prompt",
    modelRole: "luna",
    reasoningEffort: "low",
  };
}

class FakeWorker implements OfficialCodexRunExecutor {
  isActive = false;
  requests: OfficialCodexRunRequest[] = [];

  async run(request: OfficialCodexRunRequest): Promise<OfficialCodexRunResult> {
    this.requests.push(request);
    return {
      runId: request.runId,
      conversationId: "conversation",
      turnId: "turn",
      outcome: "completed",
      finalResponse: "done",
      requestedModelRole: request.modelRole,
      requestedModelId: "model-from-fixture",
      requestedReasoningEffort: request.reasoningEffort,
      recordedModelId: "model-from-fixture",
      recordedReasoningEffort: request.reasoningEffort,
      startedAt: "2026-08-23T00:00:00.000Z",
      finishedAt: "2026-08-23T00:00:01.000Z",
    };
  }

  async cancel(): Promise<"none"> {
    return "none";
  }
}

function workspaceResolver(workspacePath: string): WorkspaceResolver {
  return { getWorkspaceFolders: async () => [{ scheme: "file", path: workspacePath }] };
}

function extensionResolver(version = "26.814.41407"): OfficialExtensionResolver {
  return {
    getOfficialExtension: async () => ({
      version,
      isActive: true,
      activate: async () => undefined,
    }),
  };
}

async function withWorkspaces(
  run: (paths: { workspace: string; alias: string; other: string }) => Promise<void>,
): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiflow-service-test-"));
  const workspace = path.join(base, "workspace");
  const alias = path.join(base, "workspace-alias");
  const other = path.join(base, "other");
  await fs.mkdir(workspace);
  await fs.mkdir(other);
  await fs.symlink(workspace, alias);
  try {
    await run({ workspace: await fs.realpath(workspace), alias, other: await fs.realpath(other) });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}
