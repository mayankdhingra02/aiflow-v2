import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import { BrowserBridge, type BrowserBridgeSecretStorage } from "../src/browserBridge";
import { createBrowserBridgeMessage, reviewEnvelopeSha256, sha256Hex, type BrowserBridgeMessageV1 } from "../src/browserBridgeProtocol";
import type { ImplementationReviewEnvelopeV1 } from "../src/gitImplementationContracts";
import { createChatGPTReviewRequest, reviewDecisionSha256 } from "../src/reviewHandoffContracts";

const EXTENSION_ID = "a".repeat(32);

test("browser bridge server factory receives only the loopback bind address", async () => {
  let captured: { host: string; port: number; maxPayload: number } | null = null;
  const bridge = new BrowserBridge({
    port: () => 47_323,
    secrets: new MemorySecrets(),
    serverFactory: (options) => {
      captured = options;
      return new FakeServer(options.port) as unknown as WebSocketServer;
    },
  });
  try {
    await bridge.beginPairing();
    assert.deepEqual(captured, { host: "127.0.0.1", port: 47_323, maxPayload: 1_048_576 });
  } finally { await bridge.dispose(); }
});

test("server rejects invalid Origins, expires unauthenticated sockets, and terminates tracked sockets on disposal", async () => {
  const bridge = new BrowserBridge({
    port: () => 47_323,
    secrets: new MemorySecrets(),
    handshakeTimeoutMs: 1,
    serverFactory: () => new FakeServer(47_323) as unknown as WebSocketServer,
  });
  await bridge.beginPairing();
  const invalid = new EventedSocket();
  (bridge as any).onConnection(invalid, "https://example.com");
  assert.equal(invalid.closed, true);
  const idle = new EventedSocket();
  (bridge as any).onConnection(idle, `chrome-extension://${EXTENSION_ID}`);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(idle.closed, true);
  const tracked = new EventedSocket();
  (bridge as any).onConnection(tracked, `chrome-extension://${EXTENSION_ID}`);
  await bridge.dispose();
  assert.equal(tracked.terminated, true);
});

test("pairing is single-use, persists only a token hash, and requires the extension Origin", async () => {
  await withBridge(async ({ bridge, secrets, now }) => {
    const pairing = await bridge.beginPairing();
    assert.match(pairing.pairingCode, /^[0-9a-f]{32}$/);
    const connection = connectionFor();
    await dispatch(bridge, connection, createBrowserBridgeMessage("pair_request", { extensionId: EXTENSION_ID, pairingCode: pairing.pairingCode }, now));
    const paired = sent(connection)[0];
    assert.equal(paired.type, "pair_success");
    assert.equal((paired.payload as Record<string, unknown>).extensionId, EXTENSION_ID);
    assert.equal(secrets.values.get("aiflow.browserBridge.extensionId"), EXTENSION_ID);
    assert.match(secrets.values.get("aiflow.browserBridge.browserTokenHash") ?? "", /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify([...secrets.values.values()]).includes(String((paired.payload as Record<string, unknown>).browserToken)), false);
    const reused = connectionFor();
    await dispatch(bridge, reused, createBrowserBridgeMessage("pair_request", { extensionId: EXTENSION_ID, pairingCode: pairing.pairingCode }, now));
    assert.equal(sent(reused)[0].type, "error");
    assert.equal((reused.socket as unknown as FakeSocket).closed, true);
  });
});

test("authentication gates application messages, validates exact prompts, and revocation closes the browser", async () => {
  await withBridge(async ({ bridge, now }) => {
    const token = await pair(bridge, now);
    const unpaired = connectionFor();
    await dispatch(bridge, unpaired, createBrowserBridgeMessage("ping", {}, now));
    assert.equal(sent(unpaired)[0].type, "error");
    const authenticated = await authenticate(bridge, token, now);
    const text = "AIFLOW_BRIDGE_TEST_🙂\nsecond line";
    await dispatch(bridge, authenticated, createBrowserBridgeMessage("browser_test_prompt", { text, utf8Bytes: Buffer.byteLength(text), sha256: sha256Hex(text) }, now));
    assert.equal(sent(authenticated).at(-1)?.type, "ack");
    assert.equal((await bridge.status()).latestTestPrompt?.utf8Bytes, Buffer.byteLength(text));
    await bridge.revoke();
    assert.equal((authenticated.socket as unknown as FakeSocket).closed, true);
    assert.equal((await bridge.status()).pairedExtensionId, null);
  });
});

test("review delivery requires a correlated acknowledgement and rejects disconnected or wrong acknowledgements", async () => {
  await withBridge(async ({ bridge, now }) => {
    const token = await pair(bridge, now);
    const connection = await authenticate(bridge, token, now);
    const envelope = syntheticEnvelope();
    const delivery = bridge.sendImplementationReviewEnvelope(envelope);
    const outbound = sent(connection).at(-1)!;
    assert.equal(outbound.type, "implementation_review_envelope");
    await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: envelope.runId, sha256: reviewEnvelopeSha256(envelope) }, now, outbound.id));
    assert.equal((await delivery).runId, envelope.runId);
    const wrong = bridge.sendImplementationReviewEnvelope(envelope);
    const next = sent(connection).at(-1)!;
    await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: envelope.runId, sha256: "0".repeat(64) }, now, next.id));
    await assert.rejects(wrong, /did not match/);
    await (bridge as any).closeAuthenticated(1001, "test disconnect");
    await assert.rejects(bridge.sendImplementationReviewEnvelope(envelope), /no authenticated browser/);
  });
});

test("review decisions require an acknowledged envelope and a matching one-time review request", async () => {
  await withBridge(async ({ bridge, now }) => {
    const token = await pair(bridge, now);
    const connection = await authenticate(bridge, token, now);
    const envelope = syntheticEnvelope();
    const beforeDelivery = createChatGPTReviewRequest(envelope, { now, uuid: () => "00000000-0000-4000-8000-000000000010" });
    const rejected = connectionFor();
    await dispatch(bridge, rejected, createBrowserBridgeMessage("review_decision", { version: 1, requestId: beforeDelivery.requestId, runId: beforeDelivery.runId, envelopeSha256: beforeDelivery.envelopeSha256, verdict: "SHIP", reviewedAt: now().toISOString() }, now));
    assert.equal(sent(rejected)[0].type, "error");

    const delivery = bridge.sendImplementationReviewEnvelope(envelope);
    const deliveryMessage = sent(connection).at(-1)!;
    await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: envelope.runId, sha256: reviewEnvelopeSha256(envelope) }, now, deliveryMessage.id));
    await delivery;

    const request = createChatGPTReviewRequest(envelope, { now, uuid: () => "00000000-0000-4000-8000-000000000011" });
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", request, now));
    const requestAck = sent(connection).at(-1)!;
    assert.equal(requestAck.type, "ack");
    const decision = { version: 1 as const, requestId: request.requestId, runId: request.runId, envelopeSha256: request.envelopeSha256, verdict: "CHANGES_REQUESTED" as const, modelRole: "sol" as const, reasoningEffort: "high" as const, codexInstruction: "Fix this exact line 🙂\nand this one.", reviewedAt: now().toISOString() };
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_decision", decision, now));
    const decisionAck = sent(connection).at(-1)!;
    assert.deepEqual(decisionAck.payload, { requestId: request.requestId, runId: request.runId, envelopeSha256: request.envelopeSha256, verdict: "CHANGES_REQUESTED", decisionSha256: reviewDecisionSha256(decision) });
    assert.equal(bridge.getLatestReviewDecision()?.decision.codexInstruction, decision.codexInstruction);
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_decision", decision, now));
    assert.equal(sent(connection).at(-1)?.type, "error");
  });
});

test("revocation and replacement close old review correlation without candidate resurrection", async () => {
  await withBridge(async ({ bridge, now }) => {
    const token = await pair(bridge, now); const connection = await authenticate(bridge, token, now); const envelopeA = syntheticEnvelope();
    const deliverA = bridge.sendImplementationReviewEnvelope(envelopeA); const outboundA = sent(connection).at(-1)!;
    await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: envelopeA.runId, sha256: reviewEnvelopeSha256(envelopeA) }, now, outboundA.id)); await deliverA;
    const requestA = createChatGPTReviewRequest(envelopeA, { now, uuid: () => "00000000-0000-4000-8000-000000000021" }); await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", requestA, now));
    await bridge.revoke(); const newToken = await pair(bridge, now); const second = await authenticate(bridge, newToken, now);
    await dispatch(bridge, second, createBrowserBridgeMessage("review_request", requestA, now)); assert.equal(sent(second).at(-1)?.type, "error"); assert.equal(bridge.getExecutionCandidate(), null);
    const envelopeB = syntheticEnvelope(); const deliverB = bridge.sendImplementationReviewEnvelope(envelopeB); const outboundB = sent(second).at(-1)!;
    const decisionA = { version: 1 as const, requestId: requestA.requestId, runId: requestA.runId, envelopeSha256: requestA.envelopeSha256, verdict: "CHANGES_REQUESTED" as const, modelRole: "terra" as const, reasoningEffort: "high" as const, codexInstruction: "old", reviewedAt: now().toISOString() };
    await dispatch(bridge, second, createBrowserBridgeMessage("review_decision", decisionA, now)); assert.equal(sent(second).at(-1)?.type, "error");
    await dispatch(bridge, second, createBrowserBridgeMessage("ack", { runId: envelopeB.runId, sha256: reviewEnvelopeSha256(envelopeB) }, now, outboundB.id)); await deliverB;
    assert.equal(bridge.getExecutionCandidate(), null);
  });
});

test("revoked review request is rejected after re-pair without candidate recreation", async () => {
  await withBridge(async ({ bridge, now }) => {
    const token = await pair(bridge, now); const connection = await authenticate(bridge, token, now); const envelope = syntheticEnvelope();
    const delivery = bridge.sendImplementationReviewEnvelope(envelope); const outbound = sent(connection).at(-1)!; await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: envelope.runId, sha256: reviewEnvelopeSha256(envelope) }, now, outbound.id)); await delivery;
    const request = createChatGPTReviewRequest(envelope, { now, uuid: () => "00000000-0000-4000-8000-000000000031" }); await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", request, now)); await bridge.revoke();
    const next = await authenticate(bridge, await pair(bridge, now), now); await dispatch(bridge, next, createBrowserBridgeMessage("review_request", request, now));
    assert.equal(sent(next).at(-1)?.type, "error"); assert.equal(bridge.getExecutionCandidate(), null);
  });
});

test("revoked review decision is rejected after re-pair without candidate recreation", async () => {
  await withBridge(async ({ bridge, now }) => {
    const connection = await authenticate(bridge, await pair(bridge, now), now); const envelope = syntheticEnvelope(); const delivery = bridge.sendImplementationReviewEnvelope(envelope); const outbound = sent(connection).at(-1)!; await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: envelope.runId, sha256: reviewEnvelopeSha256(envelope) }, now, outbound.id)); await delivery;
    const request = createChatGPTReviewRequest(envelope, { now, uuid: () => "00000000-0000-4000-8000-000000000032" }); await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", request, now)); await bridge.revoke();
    const next = await authenticate(bridge, await pair(bridge, now), now); const decision = changes(request, now); await dispatch(bridge, next, createBrowserBridgeMessage("review_decision", decision, now));
    assert.equal(sent(next).at(-1)?.type, "error"); assert.equal(bridge.getExecutionCandidate(), null);
  });
});

test("replacement acknowledgement installs only B and permits only B candidate", async () => {
  await withBridge(async ({ bridge, now }) => {
    const connection = await authenticate(bridge, await pair(bridge, now), now); const a = syntheticEnvelope(); const da = bridge.sendImplementationReviewEnvelope(a); let out = sent(connection).at(-1)!; await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: a.runId, sha256: reviewEnvelopeSha256(a) }, now, out.id)); await da;
    const ra = createChatGPTReviewRequest(a, { now, uuid: () => "00000000-0000-4000-8000-000000000033" }); await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", ra, now)); const b = syntheticEnvelope(); const db = bridge.sendImplementationReviewEnvelope(b); out = sent(connection).at(-1)!;
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_decision", changes(ra, now), now)); assert.equal(sent(connection).at(-1)?.type, "error"); await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: b.runId, sha256: reviewEnvelopeSha256(b) }, now, out.id)); await db;
    const rb = createChatGPTReviewRequest(b, { now, uuid: () => "00000000-0000-4000-8000-000000000034" }); await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", rb, now)); await dispatch(bridge, connection, createBrowserBridgeMessage("review_decision", changes(rb, now), now));
    assert.equal(bridge.getExecutionCandidate()?.requestId, rb.requestId); assert.notEqual(bridge.getExecutionCandidate()?.requestId, ra.requestId);
  });
});

test("replacement timeout closes A without replay or candidate resurrection", async () => {
  await withBridge(async ({ bridge, now }) => {
    const connection = await authenticate(bridge, await pair(bridge, now), now); const a = syntheticEnvelope(); const da = bridge.sendImplementationReviewEnvelope(a); const oa = sent(connection).at(-1)!; await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: a.runId, sha256: reviewEnvelopeSha256(a) }, now, oa.id)); await da;
    const ra = createChatGPTReviewRequest(a, { now, uuid: () => "00000000-0000-4000-8000-000000000035" }); await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", ra, now)); const sentBefore = sent(connection).length; const rejected = bridge.sendImplementationReviewEnvelope(syntheticEnvelope()); await assert.rejects(rejected, /Timed out/);
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", ra, now)); await dispatch(bridge, connection, createBrowserBridgeMessage("review_decision", changes(ra, now), now)); assert.equal(bridge.getExecutionCandidate(), null); assert.equal(sent(connection).length, sentBefore + 3);
  });
});

test("terminal execution history survives replacement while its candidate is unavailable", async () => {
  await withBridge(async ({ bridge, now }) => {
    const connection = await authenticate(bridge, await pair(bridge, now), now);
    const envelopeA = syntheticEnvelope();
    const deliveryA = bridge.sendImplementationReviewEnvelope(envelopeA);
    const outboundA = sent(connection).at(-1)!;
    await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: envelopeA.runId, sha256: reviewEnvelopeSha256(envelopeA) }, now, outboundA.id));
    await deliveryA;
    const requestA = createChatGPTReviewRequest(envelopeA, { now, uuid: () => "00000000-0000-4000-8000-000000000036" });
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", requestA, now));
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_decision", changes(requestA, now), now));
    const candidateA = bridge.getExecutionCandidate()!;
    const keyA = { requestId: candidateA.requestId, envelopeSha256: candidateA.envelopeSha256, decisionSha256: candidateA.decisionSha256 };
    assert.ok(bridge.reserveExecutionCandidate(keyA));
    assert.equal(bridge.consumeExecutionCandidate(keyA), true);
    bridge.markExecutionRecord(keyA, {
      executionState: "completed", executionRunId: "00000000-0000-4000-8000-000000000037",
      finishedAt: now().toISOString(), codexOutcome: "completed", gitDeliveryStatus: "verified",
      resultHeadSha: "2".repeat(40), pushVerified: true, resultAvailableForBrowserDelivery: true,
    });

    const replacement = bridge.sendImplementationReviewEnvelope(syntheticEnvelope());
    assert.equal(bridge.getExecutionCandidate(), null);
    assert.equal(bridge.getLatestExecutionRecord()?.executionState, "completed");
    assert.equal(bridge.getLatestExecutionRecord()?.reviewCorrelationState, "superseded");
    await assert.rejects(replacement, /Timed out/);
  });
});

test("terminal execution history survives revoke while its candidate is unavailable", async () => {
  await withBridge(async ({ bridge, now }) => {
    const connection = await authenticate(bridge, await pair(bridge, now), now);
    const envelope = syntheticEnvelope();
    const delivery = bridge.sendImplementationReviewEnvelope(envelope);
    const outbound = sent(connection).at(-1)!;
    await dispatch(bridge, connection, createBrowserBridgeMessage("ack", { runId: envelope.runId, sha256: reviewEnvelopeSha256(envelope) }, now, outbound.id));
    await delivery;
    const request = createChatGPTReviewRequest(envelope, { now, uuid: () => "00000000-0000-4000-8000-000000000038" });
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_request", request, now));
    await dispatch(bridge, connection, createBrowserBridgeMessage("review_decision", changes(request, now), now));
    const candidate = bridge.getExecutionCandidate()!;
    const key = { requestId: candidate.requestId, envelopeSha256: candidate.envelopeSha256, decisionSha256: candidate.decisionSha256 };
    assert.ok(bridge.reserveExecutionCandidate(key));
    assert.equal(bridge.consumeExecutionCandidate(key), true);
    bridge.markExecutionRecord(key, {
      executionState: "completed", executionRunId: "00000000-0000-4000-8000-000000000039",
      finishedAt: now().toISOString(), codexOutcome: "completed", gitDeliveryStatus: "verified",
      resultHeadSha: "2".repeat(40), pushVerified: true, resultAvailableForBrowserDelivery: true,
    });

    await bridge.revoke();
    assert.equal(bridge.getExecutionCandidate(), null);
    assert.equal(bridge.getLatestExecutionRecord()?.executionState, "completed");
    assert.equal(bridge.getLatestExecutionRecord()?.reviewCorrelationState, "revoked");
  });
});

test("expired pairing, invalid web origins, binary frames, and replacement connections are rejected deterministically", async () => {
  await withBridge(async ({ bridge, now, advance }) => {
    const pairing = await bridge.beginPairing();
    advance(5 * 60_000 + 1);
    const expired = connectionFor();
    await dispatch(bridge, expired, createBrowserBridgeMessage("pair_request", { extensionId: EXTENSION_ID, pairingCode: pairing.pairingCode }, now));
    assert.equal(sent(expired)[0].type, "error");
    const fresh = await pair(bridge, now);
    const web = connectionFor("https://chatgpt.com");
    await dispatch(bridge, web, createBrowserBridgeMessage("authenticate", { extensionId: EXTENSION_ID, browserToken: fresh }, now));
    assert.equal(sent(web)[0].type, "error");
    const first = await authenticate(bridge, fresh, now);
    const second = await authenticate(bridge, fresh, now);
    assert.equal((first.socket as unknown as FakeSocket).closed, true);
    await (bridge as any).onMessage(second, Buffer.from("binary"), true);
    assert.equal((second.socket as unknown as FakeSocket).closed, true);
  });
});

async function withBridge(run: (fixture: { bridge: BrowserBridge; secrets: MemorySecrets; now: () => Date; advance: (milliseconds: number) => void }) => Promise<void>): Promise<void> {
  let instant = new Date("2026-08-26T12:00:00.000Z");
  const now = () => instant;
  const secrets = new MemorySecrets();
  const bridge = new BrowserBridge({
    port: () => 47_901,
    secrets,
    now,
    acknowledgementTimeoutMs: 20,
    serverFactory: () => new FakeServer(47_901) as unknown as WebSocketServer,
  });
  try { await run({ bridge, secrets, now, advance: (milliseconds) => { instant = new Date(instant.getTime() + milliseconds); } }); }
  finally { await bridge.dispose(); }
}

function connectionFor(origin = `chrome-extension://${EXTENSION_ID}`) {
  return { socket: new FakeSocket() as unknown as WebSocket, origin, authenticated: false, extensionId: null };
}

async function dispatch(bridge: BrowserBridge, connection: ReturnType<typeof connectionFor>, message: BrowserBridgeMessageV1): Promise<void> {
  await (bridge as any).onMessage(connection, Buffer.from(JSON.stringify(message), "utf8"), false);
}

function sent(connection: ReturnType<typeof connectionFor>): BrowserBridgeMessageV1[] {
  return ((connection.socket as unknown as FakeSocket).sent).map((value) => JSON.parse(value) as BrowserBridgeMessageV1);
}

async function pair(bridge: BrowserBridge, now: () => Date): Promise<string> {
  const pairing = await bridge.beginPairing();
  const connection = connectionFor();
  await dispatch(bridge, connection, createBrowserBridgeMessage("pair_request", { extensionId: EXTENSION_ID, pairingCode: pairing.pairingCode }, now));
  return (sent(connection)[0].payload as Record<string, string>).browserToken;
}

async function authenticate(bridge: BrowserBridge, token: string, now: () => Date) {
  const connection = connectionFor();
  await dispatch(bridge, connection, createBrowserBridgeMessage("authenticate", { extensionId: EXTENSION_ID, browserToken: token }, now));
  assert.equal(sent(connection)[0].type, "authenticated");
  return connection;
}

function changes(request: ReturnType<typeof createChatGPTReviewRequest>, now: () => Date) {
  return {
    version: 1 as const,
    requestId: request.requestId,
    runId: request.runId,
    envelopeSha256: request.envelopeSha256,
    verdict: "CHANGES_REQUESTED" as const,
    modelRole: "terra" as const,
    reasoningEffort: "high" as const,
    codexInstruction: "Fix 🙂\nexactly",
    reviewedAt: now().toISOString(),
  };
}

class MemorySecrets implements BrowserBridgeSecretStorage {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key); }
  async store(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

class FakeServer extends EventEmitter {
  constructor(private readonly port: number) { super(); queueMicrotask(() => this.emit("listening")); }
  address() { return { port: this.port }; }
  close(callback: () => void) { callback(); return this; }
}

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  closed = false;
  send(value: string) { this.sent.push(value); }
  close() { this.closed = true; this.readyState = WebSocket.CLOSED; }
}

class EventedSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  closed = false;
  terminated = false;
  send() {}
  close() { this.closed = true; this.readyState = WebSocket.CLOSED; this.emit("close"); }
  terminate() { this.terminated = true; this.close(); }
}

function syntheticEnvelope(): ImplementationReviewEnvelopeV1 {
  const time = "2026-08-26T12:00:00.000Z";
  return { version: 1, runId: randomUUID(), githubRepository: "synthetic/aiflow-bridge", branch: "main", baseSha: "0".repeat(40), headSha: "1".repeat(40), commitShas: [], pushVerified: false, deliveryStatus: "no_commit", codexOutcome: "cancelled", codexFinalResponse: "Synthetic transport test", modelRole: "terra", modelId: "gpt-5.6-codex", reasoningEffort: "medium", conversationId: randomUUID(), turnId: randomUUID(), startedAt: time, finishedAt: time };
}
