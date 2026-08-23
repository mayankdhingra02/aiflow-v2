import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  canonicalPathsEqual,
  findBootstrapMatches,
  findNewSessionPaths,
  inspectTurnRecords,
  snapshotSessions,
  waitForBootstrapSession,
  type SessionBoundary,
} from "../src/sessionStore";

test("session snapshot comparison returns only identities created afterward", async () => {
  await withSessionRoot(async (root) => {
    const oldPath = await writeSession(root, "old.jsonl", bootstrapRecords("old", "nonce"));
    const snapshot = await snapshotSessions(root);
    const newPath = await writeSession(root, "new.jsonl", bootstrapRecords("new", "other"));

    assert.deepEqual(await findNewSessionPaths(root, snapshot), [await fs.realpath(newPath)]);
    assert.notEqual(await fs.realpath(oldPath), await fs.realpath(newPath));
  });
});

test("pre-existing nonce sessions are rejected by the bootstrap snapshot", async () => {
  await withSessionRoot(async (root) => {
    await writeSession(root, "old.jsonl", bootstrapRecords("old", "same-nonce"));
    const snapshot = await snapshotSessions(root);

    assert.deepEqual(await findBootstrapMatches(root, snapshot, "same-nonce"), []);
  });
});

test("multiple newly created nonce-matching sessions remain distinguishable for rejection", async () => {
  await withSessionRoot(async (root) => {
    const snapshot = await snapshotSessions(root);
    await writeSession(root, "one.jsonl", bootstrapRecords("one", "same-nonce"));
    await writeSession(root, "two.jsonl", bootstrapRecords("two", "same-nonce"));

    const matches = await findBootstrapMatches(root, snapshot, "same-nonce");
    assert.equal(matches.length, 2);
    assert.deepEqual(
      new Set(matches.map((match) => match.inspection.conversationId)),
      new Set(["one", "two"]),
    );
    await assert.rejects(
      waitForBootstrapSession({
        sessionsRoot: root,
        snapshot,
        nonce: "same-nonce",
        expectedMarker: "AIFLOW_BOOTSTRAP_same-nonce",
        canonicalWorkspace: root,
        timeoutMs: 50,
        pollIntervalMs: 1,
      }),
      /Multiple newly created Codex sessions/,
    );
  });
});

test("canonical workspace verification resolves symbolic links", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "aiflow-canonical-test-"));
  const workspace = path.join(base, "workspace");
  const link = path.join(base, "workspace-link");
  const other = path.join(base, "other");
  await fs.mkdir(workspace);
  await fs.mkdir(other);
  await fs.symlink(workspace, link);

  try {
    assert.equal(await canonicalPathsEqual(workspace, link), true);
    assert.equal(await canonicalPathsEqual(workspace, other), false);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("turn inspection correlates exact prompt and turn after the boundary", () => {
  const bootstrap = "bootstrap-turn";
  const real = "real-turn";
  const unrelated = "unrelated-turn";
  const prompt = "Return exactly AIFLOW_ACCEPT_nonce. Do not modify files.";
  const before = [
    sessionMeta("conversation", "/workspace"),
    event("task_started", { turn_id: bootstrap }),
    event("task_complete", { turn_id: bootstrap, last_agent_message: "bootstrap" }),
  ];
  const boundary: SessionBoundary = {
    recordCount: before.length,
    turnIds: new Set([bootstrap]),
  };
  const records = [
    ...before,
    event("task_started", { turn_id: unrelated }),
    event("user_message", { message: "an unrelated prompt" }),
    event("task_complete", { turn_id: unrelated, last_agent_message: "unrelated" }),
    event("task_started", { turn_id: real }),
    turnContext(real, "gpt-5.6-luna", "low"),
    event("user_message", { message: prompt }),
    event("agent_message", { message: "AIFLOW_ACCEPT_nonce", phase: "final_answer" }),
    event("task_complete", { turn_id: real, last_agent_message: "AIFLOW_ACCEPT_nonce" }),
  ];

  assert.deepEqual(inspectTurnRecords(records, boundary, prompt, real), {
    turnId: real,
    promptCorrelated: true,
    outcome: "completed",
    finalResponse: "AIFLOW_ACCEPT_nonce",
    recordedModel: "gpt-5.6-luna",
    recordedReasoning: "low",
  });
  assert.throws(
    () => inspectTurnRecords(records, boundary, prompt, unrelated),
    /does not match the prompt-correlated turn ID/,
  );
});

test("turn inspection rejects a response turn ID that predates the boundary", () => {
  const records = [sessionMeta("conversation", "/workspace")];
  const boundary: SessionBoundary = {
    recordCount: records.length,
    turnIds: new Set(["old-turn"]),
  };
  assert.throws(
    () => inspectTurnRecords(records, boundary, "prompt", "old-turn"),
    /existed before/,
  );
});

async function withSessionRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiflow-session-test-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeSession(
  root: string,
  name: string,
  records: Record<string, unknown>[],
): Promise<string> {
  const directory = path.join(root, "2026", "08", "22");
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return filePath;
}

function bootstrapRecords(conversationId: string, nonce: string): Record<string, unknown>[] {
  const turnId = `${conversationId}-turn`;
  return [
    sessionMeta(conversationId, "/workspace"),
    event("task_started", { turn_id: turnId }),
    turnContext(turnId, "bootstrap-model", "medium"),
    event("user_message", { message: `wrapper containing ${nonce}` }),
    event("task_complete", {
      turn_id: turnId,
      last_agent_message: `AIFLOW_BOOTSTRAP_${nonce}`,
    }),
  ];
}

function sessionMeta(conversationId: string, cwd: string): Record<string, unknown> {
  return {
    type: "session_meta",
    payload: { id: conversationId, session_id: conversationId, cwd },
  };
}

function turnContext(turnId: string, model: string, effort: string): Record<string, unknown> {
  return {
    type: "turn_context",
    payload: { turn_id: turnId, model, effort },
  };
}

function event(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "event_msg",
    payload: { type, ...fields },
  };
}
