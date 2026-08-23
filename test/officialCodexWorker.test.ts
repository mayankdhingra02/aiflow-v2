import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  MAX_PROMPT_BYTES,
  MODEL_ID_BY_ROLE,
  modelIdForRole,
  validateOfficialCodexRunRequest,
  type OfficialCodexRunRequest,
} from "../src/officialCodexContracts";
import {
  OfficialCodexWorker,
  type OfficialCodexIpcClient,
} from "../src/officialCodexWorker";
import type { IpcSuccessResponse } from "../src/protocol";

test("typed contracts validate requests and map every model role", () => {
  assert.equal(modelIdForRole("luna"), MODEL_ID_BY_ROLE.luna);
  assert.equal(modelIdForRole("terra"), MODEL_ID_BY_ROLE.terra);
  assert.equal(modelIdForRole("sol"), MODEL_ID_BY_ROLE.sol);

  assert.doesNotThrow(() =>
    validateOfficialCodexRunRequest({
      runId: "00000000-0000-4000-8000-000000000001",
      workspacePath: "/workspace",
      prompt: "exact prompt",
      modelRole: "terra",
      reasoningEffort: "xhigh",
    }),
  );
  assert.throws(
    () => validateOfficialCodexRunRequest({
      runId: "run-1",
      workspacePath: "/workspace",
      prompt: "exact prompt",
      modelRole: "terra",
      reasoningEffort: "xhigh",
    }),
    /valid UUID runId/,
  );
  assert.throws(
    () => validateOfficialCodexRunRequest({
      runId: "00000000-0000-4000-8000-000000000001",
      workspacePath: "relative",
      prompt: "exact prompt",
      modelRole: "terra",
      reasoningEffort: "xhigh",
    }),
    /workspacePath must be absolute/,
  );
  assert.throws(
    () => validateOfficialCodexRunRequest({
      runId: "00000000-0000-4000-8000-000000000001",
      workspacePath: "/workspace",
      prompt: "",
      modelRole: "terra",
      reasoningEffort: "xhigh",
    }),
    /non-empty prompt/,
  );
  assert.throws(
    () => validateOfficialCodexRunRequest({
      runId: "00000000-0000-4000-8000-000000000001",
      workspacePath: "/workspace",
      prompt: " \n\t ",
      modelRole: "terra",
      reasoningEffort: "xhigh",
    }),
    /non-empty prompt/,
  );
  const asciiAtLimit = "a".repeat(MAX_PROMPT_BYTES);
  const multibyteAtLimit = "🙂".repeat(MAX_PROMPT_BYTES / 4);
  assert.doesNotThrow(() => validateOfficialCodexRunRequest({
    runId: "00000000-0000-4000-8000-000000000001",
    workspacePath: "/workspace",
    prompt: asciiAtLimit,
    modelRole: "terra",
    reasoningEffort: "xhigh",
  }));
  assert.doesNotThrow(() => validateOfficialCodexRunRequest({
    runId: "00000000-0000-4000-8000-000000000001",
    workspacePath: "/workspace",
    prompt: multibyteAtLimit,
    modelRole: "terra",
    reasoningEffort: "xhigh",
  }));
  assert.throws(() => validateOfficialCodexRunRequest({
    runId: "00000000-0000-4000-8000-000000000001",
    workspacePath: "/workspace",
    prompt: `${asciiAtLimit}a`,
    modelRole: "terra",
    reasoningEffort: "xhigh",
  }), /exceeds/);
  assert.throws(() => validateOfficialCodexRunRequest({
    runId: "00000000-0000-4000-8000-000000000001",
    workspacePath: "/workspace",
    prompt: `${multibyteAtLimit}🙂`,
    modelRole: "terra",
    reasoningEffort: "xhigh",
  }), /exceeds/);
  assert.throws(
    () => validateOfficialCodexRunRequest({
      runId: "00000000-0000-4000-8000-000000000001",
      workspacePath: "/workspace",
      prompt: "exact prompt",
      modelRole: "unknown",
      reasoningEffort: "xhigh",
    }),
    /unsupported modelRole/,
  );
});

test("worker bootstraps once, sends only the exact prompt through IPC, and returns dynamic settings", async () => {
  await withFixture(async ({ workspace, sessionsRoot, tempRoot, sessionPath }) => {
    const request: OfficialCodexRunRequest = {
      runId: "00000000-0000-4000-8000-000000000002",
      workspacePath: workspace,
      prompt: "Do exactly this arbitrary task: preserve every character.",
      modelRole: "terra",
      reasoningEffort: "high",
    };
    let bootstrapArguments: { instruction: string; nonce: string; temporaryFile: string } | null = null;
    let settingsParams: Record<string, unknown> | null = null;
    let startParams: Record<string, unknown> | null = null;
    const logs: string[] = [];
    const callOrder: string[] = [];
    let completedIpc: FakeIpcClient | null = null;

    const worker = new OfficialCodexWorker({
      sessionsRoot,
      tempRoot,
      authorizeWorkspace: async (workspacePath) => workspacePath,
      now: () => new Date("2026-08-23T18:00:00.000Z"),
      log: (message) => logs.push(message),
      invokeBootstrap: async (arguments_) => {
        bootstrapArguments = arguments_;
        assert.equal((await fs.stat(arguments_.temporaryFile)).isFile(), true);
        assert.doesNotMatch(arguments_.instruction, /Do exactly this arbitrary task/);
        await fs.writeFile(
          sessionPath,
          `${[
            sessionMeta("conversation-terra", "/not-used"),
            { type: "arbitrary_record", payload: { nonce: arguments_.nonce } },
            turnContext("bootstrap", modelIdForRole("luna"), "low", workspace),
            event("task_complete", {
              turn_id: "bootstrap",
              last_agent_message: `AIFLOW_BOOTSTRAP_${arguments_.nonce}`,
            }),
          ]
            .map((record) => JSON.stringify(record))
            .join("\n")}\n`,
        );
      },
      createIpcClient: () => {
        completedIpc = new FakeIpcClient({
          onSettings: (params) => {
            callOrder.push("settings");
            settingsParams = params as Record<string, unknown>;
          },
          onStart: (params) => {
            callOrder.push("start");
            startParams = params as Record<string, unknown>;
            return appendRealTurn(sessionPath, workspace, request.prompt);
          },
        });
        return completedIpc;
      },
    });

    const result = await worker.run(request);
    const capturedBootstrap = bootstrapArguments as unknown as {
      instruction: string;
      nonce: string;
      temporaryFile: string;
    };
    assert.equal(capturedBootstrap.nonce.length, 64);
    assert.equal(result.runId, request.runId);
    assert.equal(result.conversationId, "conversation-terra");
    assert.equal(result.turnId, "real-turn");
    assert.equal(result.outcome, "completed");
    assert.equal(result.finalResponse, "arbitrary final response");
    assert.equal(result.requestedModelRole, "terra");
    assert.equal(result.requestedModelId, modelIdForRole("terra"));
    assert.equal(result.requestedReasoningEffort, "high");
    assert.equal(result.recordedModelId, modelIdForRole("terra"));
    assert.equal(result.recordedReasoningEffort, "high");
    assert.equal(result.startedAt, "2026-08-23T18:00:00.000Z");
    assert.equal(result.finishedAt, "2026-08-23T18:00:00.000Z");
    const capturedSettings = settingsParams as unknown as Record<string, unknown>;
    assert.equal(
      (capturedSettings.threadSettings as Record<string, unknown>).model,
      modelIdForRole("terra"),
    );
    assert.equal(
      (capturedSettings.threadSettings as Record<string, unknown>).effort,
      "high",
    );
    const turnStartParams = (startParams as unknown as Record<string, unknown>)
      .turnStartParams as Record<string, unknown>;
    assert.equal(turnStartParams.model, modelIdForRole("terra"));
    assert.equal(turnStartParams.effort, "high");
    assert.equal(
      ((turnStartParams.input as Array<Record<string, unknown>>)[0]).text,
      request.prompt,
    );
    assert.equal(await exists(capturedBootstrap.temporaryFile), false);
    assert.deepEqual(callOrder, ["settings", "start"]);
    assert.equal(logs.includes("worker: real turn ID: real-turn"), true);
    assert.equal((completedIpc as unknown as FakeIpcClient).disposed, true);
  });
});

test("worker permits only one active run at a time", async () => {
  await withFixture(async ({ workspace, sessionsRoot, tempRoot, sessionPath }) => {
    let releaseBootstrap!: () => void;
    const bootstrapReleased = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    let bootstrapStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bootstrapStarted = resolve;
    });
    const worker = new OfficialCodexWorker({
      sessionsRoot,
      tempRoot,
      authorizeWorkspace: async (workspacePath) => workspacePath,
      invokeBootstrap: async (arguments_) => {
        bootstrapStarted();
        await bootstrapReleased;
        await fs.writeFile(sessionPath, `${JSON.stringify(sessionMeta("conversation", workspace))}\n`);
        await fs.appendFile(
          sessionPath,
          `${[
            { type: "arbitrary", payload: { nonce: arguments_.nonce } },
            turnContext("bootstrap", modelIdForRole("luna"), "low", workspace),
            event("task_complete", {
              turn_id: "bootstrap",
              last_agent_message: `AIFLOW_BOOTSTRAP_${arguments_.nonce}`,
            }),
          ]
            .map((record) => JSON.stringify(record))
            .join("\n")}\n`,
        );
      },
      createIpcClient: () =>
        new FakeIpcClient({ onStart: (params) => appendRealTurn(sessionPath, workspace, String(
          ((params as Record<string, unknown>).turnStartParams as Record<string, unknown>)
            .input instanceof Array
            ? (((params as Record<string, unknown>).turnStartParams as Record<string, unknown>)
                .input as Array<Record<string, unknown>>)[0].text
            : "",
        )) }),
    });
    const request = makeRequest(workspace, "first");
    const firstRun = worker.run(request);
    await started;
    await assert.rejects(worker.run(makeRequest(workspace, "second")), /already active/);
    releaseBootstrap();
    const result = await firstRun;
    assert.equal(result.runId, request.runId);
  });
});

test("worker cancellation targets the exact known turn and returns cancelled", async () => {
  await withFixture(async ({ workspace, sessionsRoot, tempRoot, sessionPath }) => {
    let turnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      turnStarted = resolve;
    });
    let interruptedTurnId = "";
    const worker = new OfficialCodexWorker({
      sessionsRoot,
      tempRoot,
      authorizeWorkspace: async (workspacePath) => workspacePath,
      invokeBootstrap: async (arguments_) => {
        await fs.writeFile(
          sessionPath,
          `${[
            sessionMeta("conversation-cancel", workspace),
            { type: "arbitrary", payload: { nonce: arguments_.nonce } },
            turnContext("bootstrap", modelIdForRole("luna"), "low", workspace),
            event("task_complete", {
              turn_id: "bootstrap",
              last_agent_message: `AIFLOW_BOOTSTRAP_${arguments_.nonce}`,
            }),
          ]
            .map((record) => JSON.stringify(record))
            .join("\n")}\n`,
        );
      },
      createIpcClient: () =>
        new FakeIpcClient({
          onStart: (params) => {
            const turnStartParams = params as Record<string, unknown>;
            const prompt = String(
              (((turnStartParams.turnStartParams as Record<string, unknown>).input as Array<
                Record<string, unknown>
              >)[0]).text,
            );
            void appendPendingTurn(sessionPath, workspace, prompt).then(turnStarted);
            return { turnId: "cancel-turn" };
          },
          onInterrupt: (params) => {
            interruptedTurnId = String(params.expectedTurnId);
            return appendTerminal(sessionPath, "cancel-turn", "turn_aborted");
          },
        }),
    });

    const run = worker.run(makeRequest(workspace, "cancel-me"));
    await started;
    assert.equal(await worker.cancel(), "requested");
    const result = await run;
    assert.equal(interruptedTurnId, "cancel-turn");
    assert.equal(result.outcome, "cancelled");
    assert.equal(result.turnId, "cancel-turn");
  });
});

test("bootstrap failure sends zero real prompts and never opens IPC", async () => {
  await withFixture(async ({ workspace, sessionsRoot, tempRoot }) => {
    let ipcCreated = false;
    const worker = new OfficialCodexWorker({
      sessionsRoot,
      tempRoot,
      authorizeWorkspace: async (workspacePath) => workspacePath,
      invokeBootstrap: async () => {
        throw new Error("bootstrap command failed");
      },
      createIpcClient: () => {
        ipcCreated = true;
        throw new Error("IPC must not be opened after bootstrap failure");
      },
    });

    await assert.rejects(worker.run(makeRequest(workspace, "bootstrap-failure")), /bootstrap command failed/);
    assert.equal(ipcCreated, false);
  });
});

test("worker-level injected short timeout does not replay the real prompt and disposes IPC", async () => {
  await withFixture(async ({ workspace, sessionsRoot, tempRoot, sessionPath }) => {
    let starts = 0;
    let failedIpc: FakeIpcClient | null = null;
    const worker = new OfficialCodexWorker({
      sessionsRoot,
      tempRoot,
      authorizeWorkspace: async (workspacePath) => workspacePath,
      realTurnTimeoutMs: 8,
      pollIntervalMs: 1,
      invokeBootstrap: async (arguments_) => {
        await writeBootstrapSession(sessionPath, workspace, arguments_.nonce);
      },
      createIpcClient: () => {
        failedIpc = new FakeIpcClient({
          onStart: async (params) => {
            starts += 1;
            const prompt = String(
              ((((params as Record<string, unknown>).turnStartParams as Record<string, unknown>)
                .input as Array<Record<string, unknown>>)[0]).text,
            );
            await appendPendingTurn(sessionPath, workspace, prompt, "missing-terminal");
            return { turnId: "missing-terminal" };
          },
        });
        return failedIpc;
      },
    });

    await assert.rejects(worker.run(makeRequest(workspace, "no-replay")), /Timed out/);
    assert.equal(starts, 1);
    assert.equal((failedIpc as unknown as FakeIpcClient).disposed, true);
  });
});

test("failed terminal outcome disposes IPC", async () => {
  await withFixture(async ({ workspace, sessionsRoot, tempRoot, sessionPath }) => {
    let failedIpc: FakeIpcClient | null = null;
    const worker = new OfficialCodexWorker({
      sessionsRoot,
      tempRoot,
      authorizeWorkspace: async (workspacePath) => workspacePath,
      pollIntervalMs: 1,
      invokeBootstrap: async (arguments_) => {
        await writeBootstrapSession(sessionPath, workspace, arguments_.nonce);
      },
      createIpcClient: () => {
        failedIpc = new FakeIpcClient({
          onStart: async (params) => {
            const prompt = String(
              ((((params as Record<string, unknown>).turnStartParams as Record<string, unknown>)
                .input as Array<Record<string, unknown>>)[0]).text,
            );
            await appendFailedTurn(sessionPath, workspace, prompt);
            return { turnId: "failed-turn" };
          },
        });
        return failedIpc;
      },
    });

    const result = await worker.run(makeRequest(workspace, "terminal-failure"));
    assert.equal(result.outcome, "failed");
    assert.equal((failedIpc as unknown as FakeIpcClient).disposed, true);
  });
});

test("queued and repeated cancellation sends one exact interrupt and disposes IPC", async () => {
  await withFixture(async ({ workspace, sessionsRoot, tempRoot, sessionPath }) => {
    let releaseBootstrap!: () => void;
    const bootstrapReleased = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
    let bootstrapStarted!: () => void;
    const started = new Promise<void>((resolve) => { bootstrapStarted = resolve; });
    let interrupts = 0;
    let signalInterrupt!: () => void;
    const interruptStarted = new Promise<void>((resolve) => { signalInterrupt = resolve; });
    let releaseTerminal!: () => void;
    const terminalReleased = new Promise<void>((resolve) => { releaseTerminal = resolve; });
    let cancelledIpc: FakeIpcClient | null = null;
    const worker = new OfficialCodexWorker({
      sessionsRoot,
      tempRoot,
      authorizeWorkspace: async (workspacePath) => workspacePath,
      pollIntervalMs: 1,
      invokeBootstrap: async (arguments_) => {
        bootstrapStarted();
        await bootstrapReleased;
        await writeBootstrapSession(sessionPath, workspace, arguments_.nonce);
      },
      createIpcClient: () => {
        cancelledIpc = new FakeIpcClient({
          onStart: async (params) => {
            const prompt = String(
              ((((params as Record<string, unknown>).turnStartParams as Record<string, unknown>)
                .input as Array<Record<string, unknown>>)[0]).text,
            );
            await appendPendingTurn(sessionPath, workspace, prompt);
            return { turnId: "cancel-turn" };
          },
          onInterrupt: () => {
            interrupts += 1;
            signalInterrupt();
            return terminalReleased.then(() => appendTerminal(sessionPath, "cancel-turn", "turn_aborted"));
          },
        });
        return cancelledIpc;
      },
    });

    const run = worker.run(makeRequest(workspace, "queued-cancel"));
    await started;
    assert.equal(await worker.cancel(), "queued");
    releaseBootstrap();
    await interruptStarted;
    const repeatedCancellation = Promise.all([worker.cancel(), worker.cancel()]);
    releaseTerminal();
    assert.deepEqual(await repeatedCancellation, ["requested", "requested"]);
    const result = await run;
    assert.equal(result.outcome, "cancelled");
    assert.equal(interrupts, 1);
    assert.equal((cancelledIpc as unknown as FakeIpcClient).disposed, true);
  });
});

async function withFixture(
  run: (fixture: {
    workspace: string;
    sessionsRoot: string;
    tempRoot: string;
    sessionPath: string;
  }) => Promise<void>,
): Promise<void> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiflow-worker-test-"));
  const workspace = path.join(base, "workspace");
  const sessionsRoot = path.join(base, "sessions");
  const tempRoot = path.join(base, "worker-temp");
  const sessionPath = path.join(sessionsRoot, "session.jsonl");
  await fs.mkdir(workspace);
  await fs.mkdir(sessionsRoot);
  try {
    await run({ workspace: await fs.realpath(workspace), sessionsRoot, tempRoot, sessionPath });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
}

class FakeIpcClient implements OfficialCodexIpcClient {
  private initialized = false;
  disposed = false;

  constructor(
    private readonly callbacks: {
      onSettings?: (params: unknown) => void;
      onStart: (params: unknown) => { turnId: string } | Promise<{ turnId: string }>;
      onInterrupt?: (params: { expectedTurnId: string }) => IpcSuccessResponse | Promise<IpcSuccessResponse>;
    },
  ) {}

  async connect(): Promise<void> {
    this.initialized = true;
  }

  async request(method: string, params: unknown): Promise<IpcSuccessResponse> {
    assert.equal(this.initialized, true);
    if (method === "thread-owner-discovery") {
      return successResponse({}, "thread-owner-discovery", "owner");
    }
    if (method === "thread-follower-update-thread-settings") {
      this.callbacks.onSettings?.(params);
      return successResponse({ ok: true }, method, "owner");
    }
    if (method === "thread-follower-start-turn") {
      const result = await this.callbacks.onStart(params);
      return successResponse({ result: { turn: { id: result.turnId } } }, method, "owner");
    }
    if (method === "thread-follower-interrupt-turn") {
      const response = await this.callbacks.onInterrupt?.(
        params as { expectedTurnId: string },
      );
      return response ?? successResponse({ ok: true, interruptedTurnId: "unknown" }, method, "owner");
    }
    throw new Error(`Unexpected fake IPC method ${method}`);
  }

  dispose(): void {
    this.initialized = false;
    this.disposed = true;
  }
}

let requestSequence = 10;

function makeRequest(workspacePath: string, runId: string): OfficialCodexRunRequest {
  return {
    runId: `00000000-0000-4000-8000-${String(requestSequence++).padStart(12, "0")}`,
    workspacePath,
    prompt: `prompt-${runId}`,
    modelRole: "luna",
    reasoningEffort: "low",
  };
}

async function appendRealTurn(
  sessionPath: string,
  workspace: string,
  prompt: string,
): Promise<{ turnId: string }> {
  await fs.appendFile(
    sessionPath,
    `${[
      event("task_started", { turn_id: "real-turn" }),
      turnContext("real-turn", modelIdForRole("terra"), "high", workspace),
      event("user_message", { message: prompt }),
      event("agent_message", { message: "arbitrary final response" }),
      event("task_complete", {
        turn_id: "real-turn",
        last_agent_message: "arbitrary final response",
      }),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
  return { turnId: "real-turn" };
}

async function writeBootstrapSession(
  sessionPath: string,
  workspace: string,
  nonce: string,
): Promise<void> {
  await fs.writeFile(
    sessionPath,
    `${[
      sessionMeta("conversation", workspace),
      { type: "arbitrary", payload: { nonce } },
      turnContext("bootstrap", modelIdForRole("luna"), "low", workspace),
      event("task_complete", {
        turn_id: "bootstrap",
        last_agent_message: `AIFLOW_BOOTSTRAP_${nonce}`,
      }),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
}

async function appendPendingTurn(
  sessionPath: string,
  workspace: string,
  prompt: string,
  turnId = "cancel-turn",
): Promise<void> {
  await fs.appendFile(
    sessionPath,
    `${[
      event("task_started", { turn_id: turnId }),
      turnContext(turnId, modelIdForRole("luna"), "low", workspace),
      event("user_message", { message: prompt }),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
}

async function appendFailedTurn(
  sessionPath: string,
  workspace: string,
  prompt: string,
): Promise<void> {
  await fs.appendFile(
    sessionPath,
    `${[
      event("task_started", { turn_id: "failed-turn" }),
      turnContext("failed-turn", modelIdForRole("luna"), "low", workspace),
      event("user_message", { message: prompt }),
      event("task_failed", { turn_id: "failed-turn" }),
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
}

async function appendTerminal(
  sessionPath: string,
  turnId: string,
  type: string,
): Promise<IpcSuccessResponse> {
  await fs.appendFile(sessionPath, `${JSON.stringify(event(type, { turn_id: turnId }))}\n`);
  return successResponse({ ok: true, interruptedTurnId: turnId }, "thread-follower-interrupt-turn", "owner");
}

function sessionMeta(id: string, cwd: string): Record<string, unknown> {
  return { type: "session_meta", payload: { id, session_id: id, cwd } };
}

function turnContext(
  turnId: string,
  model: string,
  effort: string,
  cwd: string,
): Record<string, unknown> {
  return { type: "turn_context", payload: { turn_id: turnId, model, effort, cwd } };
}

function event(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: "event_msg", payload: { type, ...fields } };
}

function successResponse(
  result: unknown,
  method: string,
  handledByClientId: string,
): IpcSuccessResponse {
  return {
    type: "response",
    requestId: "fake-request",
    resultType: "success",
    method,
    handledByClientId,
    result,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}
