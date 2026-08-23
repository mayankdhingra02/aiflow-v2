import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import {
  canonicalPathsEqual,
  findBootstrapMatches,
  findNewSessionPaths,
  inspectBootstrapRecords,
  inspectTurnRecords,
  snapshotSessions,
  waitForBootstrapSession,
  waitForExactTurn,
  type SessionBoundary,
} from "../src/sessionStore";
import { REAL_TURN_TIMEOUT_MS } from "../src/constants";
import { modelIdForRole } from "../src/officialCodexContracts";

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

test("bootstrap correlation finds the nonce anywhere and uses exact terminal evidence", async () => {
  await withSessionRoot(async (root) => {
    const snapshot = await snapshotSessions(root);
    const nonce = "nonce-in-arbitrary-record";
    const turnId = "bootstrap-turn";
    await writeSession(root, "bootstrap.jsonl", [
      sessionMeta("conversation", "/deliberately-not-the-workspace"),
      { type: "arbitrary_record", payload: { nested: { probe_nonce: nonce } } },
      turnContext(turnId, "bootstrap-model", "medium", root),
      event("task_complete", {
        turn_id: turnId,
        last_agent_message: `AIFLOW_BOOTSTRAP_${nonce}`,
      }),
    ]);

    const result = await waitForBootstrapSession({
      sessionsRoot: root,
      snapshot,
      nonce,
      expectedMarker: `AIFLOW_BOOTSTRAP_${nonce}`,
      canonicalWorkspace: root,
      timeoutMs: 100,
      pollIntervalMs: 1,
    });
    assert.equal(result.conversationId, "conversation");
    assert.equal(result.bootstrapTurnId, turnId);
    assert.equal(result.recordedCwd, root);
  });
});

test("bootstrap inspection rejects duplicate and conflicting exact evidence", () => {
  const nonce = "nonce";
  const marker = "AIFLOW_BOOTSTRAP_nonce";
  const base = [
    sessionMeta("conversation", "/workspace"),
    { type: "arbitrary", payload: { nonce } },
    turnContext("turn", "model", "effort", "/workspace"),
    event("task_complete", { turn_id: "turn", last_agent_message: marker }),
  ];

  assert.match(
    inspectBootstrapRecords(
      [...base, event("task_complete", { turn_id: "turn", last_agent_message: marker })],
      nonce,
      marker,
    ).validationError ?? "",
    /duplicate exact marker completions/,
  );
  assert.match(
    inspectBootstrapRecords(
      [...base, event("turn_failed", { turn_id: "turn" })],
      nonce,
      marker,
    ).validationError ?? "",
    /conflicting or duplicate terminal evidence/,
  );
  assert.match(
    inspectBootstrapRecords(
      [
        ...base.slice(1),
        {
          type: "session_meta",
          payload: { id: "one", session_id: "two" },
        },
      ],
      nonce,
      marker,
    ).validationError ?? "",
    /conflicting conversation IDs/,
  );
});

test("completed known turn correlates the exact prompt after the boundary", () => {
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
    turnContext(real, modelIdForRole("luna"), "low"),
    event("user_message", { message: prompt }),
    event("agent_message", { message: "AIFLOW_ACCEPT_nonce", phase: "final_answer" }),
    event("task_complete", { turn_id: real, last_agent_message: "AIFLOW_ACCEPT_nonce" }),
  ];

  assert.deepEqual(inspectTurnRecords(records, boundary, prompt, real), {
    turnId: real,
    turnObserved: true,
    promptCorrelated: true,
    outcome: "completed",
    finalResponse: "AIFLOW_ACCEPT_nonce",
    recordedModel: modelIdForRole("luna"),
    recordedReasoning: "low",
  });
});

test("sanitized delayed completion fixture uses the observed supported record shape and budget", () => {
  const prompt = "synthetic implementation prompt";
  const boundary: SessionBoundary = { recordCount: 1, turnIds: new Set() };
  const records = [
    sessionMeta("synthetic-conversation", "/synthetic/workspace"),
    event("task_started", { turn_id: "synthetic-real-turn" }),
    turnContext("synthetic-real-turn", modelIdForRole("terra"), "high"),
    responseUserMessage(prompt),
    event("agent_message", { message: "synthetic final response" }),
    event("task_complete", {
      turn_id: "synthetic-real-turn",
      last_agent_message: "synthetic final response",
    }),
  ];

  const inspection = inspectTurnRecords(records, boundary, prompt, "synthetic-real-turn");
  assert.equal(inspection.outcome, "completed");
  assert.equal(inspection.turnObserved, true);
  assert.equal(inspection.promptCorrelated, true);
  // The observed production terminal arrived after the old 120-second limit.
  assert.ok(REAL_TURN_TIMEOUT_MS >= 180_000);
});

test("known turn ID rejects a prompt correlated to a different new turn", () => {
  const prompt = "exact prompt";
  const boundary: SessionBoundary = { recordCount: 1, turnIds: new Set() };
  const records = [
    sessionMeta("conversation", "/workspace"),
    event("task_started", { turn_id: "prompt-turn" }),
    event("user_message", { message: prompt }),
    event("task_complete", { turn_id: "known-turn", last_agent_message: "done" }),
  ];

  assert.throws(
    () => inspectTurnRecords(records, boundary, prompt, "known-turn"),
    /does not match the prompt-correlated turn ID/,
  );
});

test("known turn accepts immediate cancellation without a persisted user message", () => {
  const boundary: SessionBoundary = { recordCount: 1, turnIds: new Set() };
  const records = [
    sessionMeta("conversation", "/workspace"),
    event("turn_aborted", { turn_id: "real-turn" }),
  ];

  assert.deepEqual(inspectTurnRecords(records, boundary, "exact prompt", "real-turn"), {
    turnId: "real-turn",
    turnObserved: true,
    promptCorrelated: false,
    outcome: "cancelled",
    finalResponse: null,
    recordedModel: null,
    recordedReasoning: null,
  });
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

test("fallback turn inference uses the unique exact prompt after the boundary", () => {
  const prompt = "exact prompt";
  const boundary: SessionBoundary = { recordCount: 1, turnIds: new Set() };
  const records = [
    sessionMeta("conversation", "/workspace"),
    event("task_started", { turn_id: "inferred-turn" }),
    event("user_message", { message: prompt }),
    event("task_complete", { turn_id: "inferred-turn", last_agent_message: "done" }),
  ];

  const inspection = inspectTurnRecords(records, boundary, prompt, null);
  assert.equal(inspection.turnId, "inferred-turn");
  assert.equal(inspection.promptCorrelated, true);
  assert.equal(inspection.outcome, "completed");
});

test("fallback turn inference rejects multiple exact-prompt candidates", () => {
  const prompt = "exact prompt";
  const boundary: SessionBoundary = { recordCount: 1, turnIds: new Set() };
  const records = [
    sessionMeta("conversation", "/workspace"),
    event("task_started", { turn_id: "one" }),
    event("user_message", { message: prompt }),
    event("task_started", { turn_id: "two" }),
    event("user_message", { message: prompt }),
  ];

  assert.throws(
    () => inspectTurnRecords(records, boundary, prompt, null),
    /multiple new turns/,
  );
});

test("fallback turn inference rejects zero prompt candidates after timeout", async () => {
  await withSessionRoot(async (root) => {
    const sessionPath = await writeSession(root, "real-turn.jsonl", [
      sessionMeta("conversation", root),
    ]);
    await assert.rejects(
      waitForExactTurn({
        sessionPath,
        conversationId: "conversation",
        boundary: { recordCount: 1, turnIds: new Set() },
        exactPrompt: "missing prompt",
        knownTurnId: null,
        timeoutMs: 5,
        pollIntervalMs: 1,
      }),
      /without one unique exact-prompt turn/,
    );
  });
});

test("timeout diagnostics are bounded and describe only exact-turn correlation state", async () => {
  await withSessionRoot(async (root) => {
    const sessionPath = await writeSession(root, "timeout.jsonl", [sessionMeta("conversation", root)]);
    let diagnostics: import("../src/sessionStore").ExactTurnTimeoutDiagnostics | null = null;
    await assert.rejects(
      waitForExactTurn({
        sessionPath,
        sessionsRoot: root,
        conversationId: "conversation",
        boundary: { recordCount: 1, turnIds: new Set() },
        exactPrompt: "secret exact prompt must not be logged",
        knownTurnId: "known-turn",
        timeoutMs: 5,
        pollIntervalMs: 1,
        onTimeoutDiagnostics: (value) => { diagnostics = value; },
      }),
      /known real Codex turn/,
    );
    assert.deepEqual(diagnostics, {
      conversationId: "conversation",
      knownTurnId: "known-turn",
      sessionFilename: "timeout.jsonl",
      knownTurnObserved: false,
      exactPromptObserved: false,
      terminalEventTypes: [],
      anotherSameConversationCandidate: false,
    });
    assert.equal(JSON.stringify(diagnostics).includes("secret exact prompt"), false);
  });
});

const terminalCases: Array<[string, "completed" | "cancelled" | "failed"]> = [
  ["task_complete", "completed"],
  ["turn_aborted", "cancelled"],
  ["task_interrupted", "cancelled"],
  ["task_failed", "failed"],
  ["turn_failed", "failed"],
  ["error", "failed"],
];

for (const [terminalType, expectedOutcome] of terminalCases) {
  test(`turn inspection recognizes turn-scoped ${terminalType}`, () => {
    const boundary: SessionBoundary = { recordCount: 1, turnIds: new Set() };
    const fields = terminalType === "task_complete"
      ? { turn_id: "target", last_agent_message: "done" }
      : { turn_id: "target" };
    const records = [
      sessionMeta("conversation", "/workspace"),
      event(terminalType, fields),
      event("task_failed", { turn_id: "other" }),
    ];

    const inspection = inspectTurnRecords(records, boundary, "prompt not persisted", "target");
    assert.equal(inspection.outcome, expectedOutcome);
    assert.equal(inspection.turnId, "target");
  });
}

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
    turnContext(turnId, "bootstrap-model", "medium", "/workspace"),
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

function turnContext(
  turnId: string,
  model: string,
  effort: string,
  cwd?: string,
): Record<string, unknown> {
  return {
    type: "turn_context",
    payload: { turn_id: turnId, model, effort, ...(cwd ? { cwd } : {}) },
  };
}

function event(type: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "event_msg",
    payload: { type, ...fields },
  };
}

function responseUserMessage(message: string): Record<string, unknown> {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: message }],
    },
  };
}
