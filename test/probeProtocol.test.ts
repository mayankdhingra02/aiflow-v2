import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  OFFICIAL_EXTENSION_VERSION,
  assertSupportedExtensionVersion,
} from "../src/constants";
import {
  acceptanceMarker,
  bootstrapMarker,
  buildBootstrapInstruction,
  buildInterruptParams,
  buildOwnerDiscoveryParams,
  buildRealPrompt,
  buildStartTurnParams,
  buildThreadSettingsParams,
  generateNonce,
  requireExactInterruptSuccess,
  requireSettingsSuccess,
  turnIdFromStartResponse,
  withTemporaryBootstrapFile,
} from "../src/probeProtocol";
import type { IpcSuccessResponse } from "../src/protocol";

test("extension version gate accepts only the pinned official extension version", () => {
  assert.doesNotThrow(() => assertSupportedExtensionVersion(OFFICIAL_EXTENSION_VERSION));
  assert.throws(() => assertSupportedExtensionVersion("26.814.41408"), /Unsupported/);
  assert.throws(() => assertSupportedExtensionVersion(undefined), /Unsupported/);
});

test("bootstrap nonces are cryptographically sized, random hex strings", () => {
  const first = generateNonce();
  const second = generateNonce();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.match(second, /^[0-9a-f]{64}$/);
  assert.notEqual(first, second);
});

test("bootstrap instruction has only nonce probe constraints and exact marker", () => {
  const nonce = "a".repeat(64);
  const instruction = buildBootstrapInstruction(nonce);
  assert.match(instruction, new RegExp(nonce));
  assert.match(instruction, /Do not edit or modify any files/);
  assert.match(instruction, /Do not run commands/);
  assert.match(instruction, new RegExp(bootstrapMarker(nonce)));
  assert.doesNotMatch(instruction, /AIFLOW_ACCEPT/);
});

test("model and reasoning map to confirmed settings and start-turn fields", () => {
  const settings = buildThreadSettingsParams("conversation");
  const realPrompt = buildRealPrompt("nonce");
  const start = buildStartTurnParams("conversation", realPrompt, "message-id");

  assert.deepEqual(settings, {
    conversationId: "conversation",
    threadSettings: { model: "gpt-5.6-luna", effort: "low" },
  });
  assert.deepEqual(start, {
    conversationId: "conversation",
    turnStartParams: {
      input: [{ type: "text", text: realPrompt, text_elements: [] }],
      clientUserMessageId: "message-id",
      additionalContext: null,
      model: "gpt-5.6-luna",
      effort: "low",
    },
    localTurnMetadata: null,
    mcpAppModelContextAttachments: [],
  });
  assert.equal(realPrompt, "Return exactly AIFLOW_ACCEPT_nonce. Do not modify files.");
  assert.equal(acceptanceMarker("nonce"), "AIFLOW_ACCEPT_nonce");
});

test("owner discovery is constrained to the exact local conversation", () => {
  assert.deepEqual(buildOwnerDiscoveryParams("conversation"), {
    hostId: "local",
    conversationId: "conversation",
  });
});

test("settings and start response shapes are validated", () => {
  requireSettingsSuccess(successResponse({ ok: true }));
  assert.throws(() => requireSettingsSuccess(successResponse({ ok: false })), /ok=true/);

  assert.equal(
    turnIdFromStartResponse(successResponse({ result: { turn: { id: "turn-id" } } })),
    "turn-id",
  );
  assert.equal(turnIdFromStartResponse(successResponse({ result: {} })), null);
});

test("cancellation targets one exact conversation, owner, and turn", () => {
  const target = {
    conversationId: "conversation",
    ownerClientId: "owner",
    turnId: "turn",
  };
  assert.deepEqual(buildInterruptParams(target), {
    conversationId: "conversation",
    mode: "user-stop",
    expectedTurnId: "turn",
  });
  requireExactInterruptSuccess(
    successResponse({ ok: true, interruptedTurnId: "turn" }),
    "turn",
  );
  assert.throws(
    () =>
      requireExactInterruptSuccess(
        successResponse({ ok: true, interruptedTurnId: "other" }),
        "turn",
      ),
    /exact requested turn/,
  );
});

test("temporary bootstrap file is exclusive, mode 0600, and always removed", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiflow-temp-test-"));
  const workspace = path.join(base, "workspace");
  const tempRoot = path.join(base, "storage");
  await fs.mkdir(workspace);
  let observedPath = "";

  try {
    await assert.rejects(
      withTemporaryBootstrapFile({
        tempRoot,
        canonicalWorkspace: await fs.realpath(workspace),
        run: async (filePath) => {
          observedPath = filePath;
          const stats = await fs.stat(filePath);
          assert.equal(stats.mode & 0o777, 0o600);
          throw new Error("callback failure");
        },
      }),
      /callback failure/,
    );
    await assert.rejects(fs.stat(observedPath), { code: "ENOENT" });
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("temporary bootstrap file remains until bootstrap completion dependency settles", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiflow-temp-lifetime-test-"));
  const workspace = path.join(base, "workspace");
  const tempRoot = path.join(base, "storage");
  await fs.mkdir(workspace);
  let observedPath = "";
  let releaseCompletion!: () => void;
  let signalPending!: () => void;
  const completion = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    signalPending = resolve;
  });

  try {
    const operation = withTemporaryBootstrapFile({
      tempRoot,
      canonicalWorkspace: await fs.realpath(workspace),
      run: async (filePath) => {
        observedPath = filePath;
        signalPending();
        await completion;
        await fs.stat(filePath);
        return "validated";
      },
    });

    await pending;
    assert.equal((await fs.stat(observedPath)).isFile(), true);
    releaseCompletion();
    assert.equal(await operation, "validated");
    await assert.rejects(fs.stat(observedPath), { code: "ENOENT" });
  } finally {
    releaseCompletion();
    await fs.rm(base, { recursive: true, force: true });
  }
});

function successResponse(result: unknown): IpcSuccessResponse {
  return {
    type: "response",
    requestId: "request",
    resultType: "success",
    method: "method",
    handledByClientId: "owner",
    result,
  };
}
