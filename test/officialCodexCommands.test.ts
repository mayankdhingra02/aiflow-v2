import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OfficialCodexCommandController,
  boundedText,
  type ClipboardRunConfirmation,
  type OfficialCodexCommandUi,
  type OfficialCodexRunService,
} from "../src/officialCodexCommands";
import { OfficialCodexError } from "../src/officialCodexService";
import type { OfficialCodexRunRequest, OfficialCodexRunResult } from "../src/officialCodexContracts";

test("programmatic command validates and returns the shared service result", async () => {
  const service = new FakeRunService();
  const ui = new FakeUi();
  const controller = new OfficialCodexCommandController(service, ui);
  const request = makeRequest("programmatic prompt");

  const result = await controller.runProgrammatic(request);
  assert.deepEqual(result, service.resultFor(request));
  assert.equal(service.requests.length, 1);
  await assert.rejects(controller.runProgrammatic({ ...request, runId: "run-1" }), (error: unknown) => {
    assert.equal((error as OfficialCodexError).code, "INVALID_REQUEST");
    return true;
  });
  assert.equal(service.requests.length, 1);
});

test("clipboard command preserves the exact clipboard prompt and calls the shared service", async () => {
  const service = new FakeRunService();
  const ui = new FakeUi();
  ui.clipboard = "  preserve\nthis exact prompt 🙂  ";
  ui.modelRole = "sol";
  ui.reasoningEffort = "xhigh";
  const controller = new OfficialCodexCommandController(service, ui);

  const result = await controller.runClipboard();
  assert.ok(result);
  assert.equal(service.requests.length, 1);
  assert.equal(service.requests[0].prompt, ui.clipboard);
  assert.equal(service.requests[0].modelRole, "sol");
  assert.equal(service.requests[0].reasoningEffort, "xhigh");
  assert.equal(ui.confirmations.length, 1);
  assert.equal(ui.confirmations[0].promptBytes, Buffer.byteLength(ui.clipboard, "utf8"));
  assert.equal(ui.output.some((line) => line.includes(ui.clipboard)), false);
});

test("clipboard confirmation cancellation starts zero runs", async () => {
  const service = new FakeRunService();
  const ui = new FakeUi();
  ui.confirm = false;
  const controller = new OfficialCodexCommandController(service, ui);

  assert.equal(await controller.runClipboard(), undefined);
  assert.equal(service.requests.length, 0);
});

test("probe, clipboard, and cancellation surfaces share one run service", async () => {
  const service = new FakeRunService();
  const ui = new FakeUi();
  const controller = new OfficialCodexCommandController(service, ui);

  await controller.runProbe();
  await controller.runClipboard();
  await controller.cancelActiveRun();
  assert.equal(service.requests.length, 2);
  assert.equal(service.cancelCalls, 1);
  assert.equal(service.requests[0].modelRole, "luna");
  assert.equal(service.requests[0].reasoningEffort, "low");
});

test("command failures are typed and output truncation is bounded", async () => {
  const service = new FakeRunService();
  service.error = new OfficialCodexError("RUN_ACTIVE", "x".repeat(1_000));
  const ui = new FakeUi();
  const controller = new OfficialCodexCommandController(service, ui);

  await assert.rejects(controller.runProgrammatic(makeRequest("prompt")), (error: unknown) => {
    assert.equal((error as OfficialCodexError).code, "RUN_ACTIVE");
    return true;
  });
  assert.ok(ui.output.at(-1)?.length ?? 0 < 460);
  assert.equal(boundedText("x".repeat(1_000)).length, 400);
});

test("concurrent programmatic command invocation is rejected by the shared service", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let active = false;
  const service: OfficialCodexRunService = {
    async run(argument: unknown): Promise<OfficialCodexRunResult> {
      if (active) {
        throw new OfficialCodexError("RUN_ACTIVE", "An official Codex run is already active");
      }
      active = true;
      await pending;
      return new FakeRunService().resultFor(argument as OfficialCodexRunRequest);
    },
    async cancel() { return "none"; },
  };
  const controller = new OfficialCodexCommandController(service, new FakeUi());
  const first = controller.runProgrammatic(makeRequest("first"));
  await assert.rejects(controller.runProgrammatic(makeRequest("second")), (error: unknown) => {
    assert.equal((error as OfficialCodexError).code, "RUN_ACTIVE");
    return true;
  });
  release();
  await first;
});

class FakeRunService implements OfficialCodexRunService {
  requests: OfficialCodexRunRequest[] = [];
  cancelCalls = 0;
  error: Error | null = null;

  async run(argument: unknown): Promise<OfficialCodexRunResult> {
    if (this.error) {
      throw this.error;
    }
    const request = argument as OfficialCodexRunRequest;
    this.requests.push(request);
    return this.resultFor(request);
  }

  async cancel(): Promise<"none"> {
    this.cancelCalls += 1;
    return "none";
  }

  resultFor(request: OfficialCodexRunRequest): OfficialCodexRunResult {
    return {
      runId: request.runId,
      conversationId: "conversation",
      turnId: "turn",
      outcome: "completed",
      finalResponse: "final response",
      requestedModelRole: request.modelRole,
      requestedModelId: "model-from-service",
      requestedReasoningEffort: request.reasoningEffort,
      recordedModelId: "model-from-service",
      recordedReasoningEffort: request.reasoningEffort,
      startedAt: "2026-08-23T00:00:00.000Z",
      finishedAt: "2026-08-23T00:00:01.000Z",
    };
  }
}

class FakeUi implements OfficialCodexCommandUi {
  clipboard = "clipboard prompt";
  modelRole: "luna" | "terra" | "sol" | undefined = "terra";
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | undefined = "high";
  workspace = "/workspace";
  confirm = true;
  confirmations: ClipboardRunConfirmation[] = [];
  output: string[] = [];
  errors: string[] = [];

  async readClipboardText(): Promise<string> { return this.clipboard; }
  async chooseModelRole() { return this.modelRole; }
  async chooseReasoningEffort() { return this.reasoningEffort; }
  async getOpenCanonicalWorkspace(): Promise<string> { return this.workspace; }
  async confirmRun(details: ClipboardRunConfirmation): Promise<boolean> {
    this.confirmations.push(details);
    return this.confirm;
  }
  appendOutput(message: string): void { this.output.push(message); }
  showError(message: string): void { this.errors.push(message); }
}

function makeRequest(prompt: string): OfficialCodexRunRequest {
  return {
    runId: "00000000-0000-4000-8000-000000000456",
    workspacePath: "/workspace",
    prompt,
    modelRole: "luna",
    reasoningEffort: "low",
  };
}
