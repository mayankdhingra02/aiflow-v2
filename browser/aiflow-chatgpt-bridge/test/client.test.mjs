import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserBridgeClient } from "../client.mjs";

const EXTENSION_ID = "a".repeat(32);

test("Unicode prompt acknowledgement is exactly correlated and never persists prompt text", async () => {
  const fixture = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await authenticate(fixture);
  const pending = fixture.client.sendTestPrompt("AIFLOW_BRIDGE_TEST_🙂\nsecond line");
  await waitFor(() => fixture.client.promptAck);
  const outbound = fixture.socket().last();
  const request = JSON.parse(outbound);
  assert.equal(fixture.client.promptAck.id, request.id);
  assert.equal(fixture.client.promptAck.utf8Bytes, Buffer.byteLength("AIFLOW_BRIDGE_TEST_🙂\nsecond line"));
  assert.equal(fixture.client.promptAck.sha256, await digest("AIFLOW_BRIDGE_TEST_🙂\nsecond line"));
  fixture.socket().message(wire("ack", { messageId: request.id, utf8Bytes: Buffer.byteLength("AIFLOW_BRIDGE_TEST_🙂\nsecond line"), sha256: await digest("AIFLOW_BRIDGE_TEST_🙂\nsecond line") }, request.id));
  const acknowledgement = await pending;
  assert.equal(acknowledgement.utf8Bytes, Buffer.byteLength("AIFLOW_BRIDGE_TEST_🙂\nsecond line"));
  assert.equal(JSON.stringify(fixture.storage.values).includes("AIFLOW_BRIDGE_TEST"), false);
  assert.equal((await fixture.client.status()).browserToken, undefined);
});

test("wrong, stale, duplicate, and missing test-prompt acknowledgements are rejected", async () => {
  for (const mutate of [
    (request) => ({ replyTo: "00000000-0000-4000-8000-000000000001", payload: { messageId: request.id, utf8Bytes: 5, sha256: request.payload.sha256 } }),
    (request) => ({ replyTo: request.id, payload: { messageId: "00000000-0000-4000-8000-000000000001", utf8Bytes: 5, sha256: request.payload.sha256 } }),
    (request) => ({ replyTo: request.id, payload: { messageId: request.id, utf8Bytes: 4, sha256: request.payload.sha256 } }),
    (request) => ({ replyTo: request.id, payload: { messageId: request.id, utf8Bytes: 5, sha256: "0".repeat(64) } }),
  ]) {
    const fixture = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
    await authenticate(fixture);
    const pending = fixture.client.sendTestPrompt("hello");
    const rejected = assert.rejects(pending, /did not match/);
    await waitFor(() => fixture.client.promptAck);
    const request = JSON.parse(fixture.socket().last());
    const invalid = mutate({ ...request, payload: { sha256: fixture.client.promptAck.sha256 } });
    fixture.socket().message(wire("ack", invalid.payload, invalid.replyTo));
    await rejected;
  }
  const missing = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await authenticate(missing);
  const timeout = missing.client.sendTestPrompt("hello");
  const timedOut = assert.rejects(timeout, /Timed out/);
  await waitFor(() => missing.client.promptAck);
  missing.timers.runTimeouts();
  await timedOut;
  const duplicate = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await authenticate(duplicate);
  const acknowledged = duplicate.client.sendTestPrompt("hello");
  await waitFor(() => duplicate.client.promptAck);
  const request = JSON.parse(duplicate.socket().last());
  const payload = { messageId: request.id, utf8Bytes: 5, sha256: duplicate.client.promptAck.sha256 };
  duplicate.socket().message(wire("ack", payload, request.id));
  await acknowledged;
  duplicate.socket().message(wire("ack", payload, request.id));
  await tick();
  assert.equal((await duplicate.client.status()).state, "disconnected");
});

test("heartbeat requires correlated pong and clears timers on disconnect", async () => {
  const fixture = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await authenticate(fixture);
  fixture.timers.runIntervals();
  const ping = JSON.parse(fixture.socket().last());
  assert.equal(ping.type, "ping");
  fixture.socket().message(wire("pong", {}, ping.id));
  assert.equal(fixture.timers.timeouts.size, 0);
  fixture.timers.runIntervals();
  fixture.timers.runTimeouts();
  assert.equal((await fixture.client.status()).state, "disconnected");
  await fixture.client.disconnect();
  assert.equal(fixture.timers.intervals.size, 0);
});

test("pairing and authentication responses must correlate to their active requests", async () => {
  const fixture = createClient();
  await fixture.client.pair("code");
  fixture.socket().open();
  await tick();
  const pair = JSON.parse(fixture.socket().last());
  fixture.socket().message(wire("pair_success", { extensionId: EXTENSION_ID, browserToken: "token" }, "00000000-0000-4000-8000-000000000001"));
  await tick();
  assert.equal((await fixture.client.status()).state, "disconnected");
  assert.notEqual(pair.id, "00000000-0000-4000-8000-000000000001");
});

test("review envelopes are accepted only while authenticated and only after full validation", async () => {
  const fixture = createClient();
  await fixture.client.pair("code");
  fixture.socket().open();
  await tick();
  fixture.socket().message(wire("implementation_review_envelope", envelope()));
  assert.equal(fixture.storage.values.latestEnvelope, undefined);
  const invalidFixture = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await authenticate(invalidFixture);
  const invalid = { ...envelope(), branch: "bad\nbranch" };
  invalidFixture.socket().message(wire("implementation_review_envelope", invalid));
  await tick();
  assert.equal(invalidFixture.storage.values.latestEnvelope, undefined);
  const authenticatedFixture = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await authenticate(authenticatedFixture);
  const valid = envelope();
  authenticatedFixture.socket().message(wire("implementation_review_envelope", valid));
  await waitFor(() => authenticatedFixture.storage.values.latestEnvelope);
  await waitFor(() => authenticatedFixture.socket().last() && JSON.parse(authenticatedFixture.socket().last()).type === "ack");
  assert.deepEqual(authenticatedFixture.storage.values.latestEnvelope, valid);
  assert.equal(JSON.parse(authenticatedFixture.socket().last()).type, "ack");
});

test("manual review handoff persists only safe metadata and requires correlated acknowledgements", async () => {
  const fixture = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await authenticate(fixture);
  const delivered = envelope();
  fixture.socket().message(wire("implementation_review_envelope", delivered));
  await waitFor(() => fixture.storage.values.latestEnvelope);
  const requestPromise = fixture.client.createReviewRequest();
  await waitFor(() => fixture.client.reviewRequestAck);
  const requestWire = JSON.parse(fixture.socket().last());
  const request = requestWire.payload;
  fixture.socket().message(wire("ack", { requestId: request.requestId, runId: request.runId, envelopeSha256: request.envelopeSha256 }, requestWire.id));
  const copied = await requestPromise;
  assert.match(copied, /Aiflow ChatGPT Review Request V1/);
  assert.equal(JSON.stringify(fixture.storage.values).includes("Aiflow ChatGPT Review Request V1"), false);
  const pasted = ["# Implementation Review", `Request-ID: ${request.requestId}`, `Run-ID: ${request.runId}`, `Envelope-SHA256: ${request.envelopeSha256}`, "## Verdict", "CHANGES_REQUESTED", "## Codex Execution", "Model: luna", "Reasoning: high", "## Codex Instruction", "Keep this exact Unicode line 🙂", "and this second line."].join("\n");
  const decisionPromise = fixture.client.sendReviewDecision(pasted);
  await waitFor(() => fixture.client.reviewDecisionAck);
  const decisionWire = JSON.parse(fixture.socket().last());
  const pending = fixture.client.reviewDecisionAck;
  fixture.socket().message(wire("ack", { requestId: request.requestId, runId: request.runId, envelopeSha256: request.envelopeSha256, verdict: "CHANGES_REQUESTED", decisionSha256: pending.decisionSha256 }, decisionWire.id));
  const acknowledgement = await decisionPromise;
  assert.equal(acknowledgement.verdict, "CHANGES_REQUESTED");
  assert.equal(fixture.storage.values.latestReviewDecision.codexInstruction, undefined);
  assert.equal(JSON.stringify(fixture.storage.values).includes(pasted), false);
  assert.equal((await fixture.client.status()).browserToken, undefined);
});

test("non-text and oversized frames, manual disconnect, duplicate connect, stale sockets, and notifications are controlled", async () => {
  const fixture = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await fixture.client.connect();
  await fixture.client.connect();
  assert.equal(fixture.sockets.length, 1);
  const stale = fixture.socket();
  stale.open();
  await tick();
  stale.message({ binary: true });
  assert.equal((await fixture.client.status()).state, "disconnected");
  const oversized = createClient({ extensionId: EXTENSION_ID, browserToken: "token" });
  await authenticate(oversized);
  oversized.socket().message("x".repeat(1_048_577));
  await tick();
  assert.equal((await oversized.client.status()).state, "disconnected");
  await fixture.client.disconnect();
  assert.equal(fixture.timers.timeouts.size, 0);
  stale.close();
  assert.equal(fixture.sockets.length, 1);
  await fixture.client.connect(true);
  assert.equal(fixture.sockets.length, 2);
  assert.equal(fixture.events.some((event) => event.type === "bridge_state"), true);
});

async function authenticate(fixture) {
  await fixture.client.connect();
  fixture.socket().open();
  await tick();
  const request = JSON.parse(fixture.socket().last());
  fixture.socket().message(wire("authenticated", { extensionId: EXTENSION_ID }, request.id));
  await tick();
  assert.equal((await fixture.client.status()).state, "authenticated");
}

function createClient(initial = {}) {
  const storage = new Storage(initial);
  const timers = new Timers();
  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.sent = []; sockets.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; this.listeners.get("close")?.(); }
    open() { this.readyState = 1; this.listeners.get("open")?.(); }
    message(data) { this.listeners.get("message")?.({ data }); }
    last() { return this.sent.at(-1); }
  }
  let id = 2;
  const client = new BrowserBridgeClient({ WebSocket: FakeWebSocket, extensionId: EXTENSION_ID, storage, now: () => new Date("2026-08-26T12:00:00.000Z"), uuid: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`, setTimeout: timers.setTimeout.bind(timers), clearTimeout: timers.clearTimeout.bind(timers), setInterval: timers.setInterval.bind(timers), clearInterval: timers.clearInterval.bind(timers), notify: (event) => events.push(event) });
  const events = [];
  return { client, storage, timers, sockets, events, socket: () => sockets.at(-1) };
}

class Storage {
  constructor(values) { this.values = { ...values }; }
  async get(defaults) { return { ...defaults, ...this.values }; }
  async set(values) { Object.assign(this.values, values); }
  async remove(keys) { for (const key of keys) delete this.values[key]; }
}

class Timers {
  constructor() { this.next = 1; this.timeouts = new Map(); this.intervals = new Map(); }
  setTimeout(callback) { const id = this.next++; this.timeouts.set(id, callback); return id; }
  clearTimeout(id) { this.timeouts.delete(id); }
  setInterval(callback) { const id = this.next++; this.intervals.set(id, callback); return id; }
  clearInterval(id) { this.intervals.delete(id); }
  runTimeouts() { const tasks = [...this.timeouts.values()]; this.timeouts.clear(); for (const task of tasks) task(); }
  runIntervals() { for (const task of this.intervals.values()) task(); }
}

function wire(type, payload, replyTo) { return JSON.stringify({ version: 1, id: "00000000-0000-4000-8000-000000000001", type, sentAt: "2026-08-26T12:00:00.000Z", ...(replyTo ? { replyTo } : {}), payload }); }
function envelope() { return { version: 1, runId: "00000000-0000-4000-8000-000000000002", githubRepository: "synthetic/aiflow-bridge", branch: "main", baseSha: "0".repeat(40), headSha: "1".repeat(40), commitShas: [], pushVerified: false, deliveryStatus: "no_commit", codexOutcome: "cancelled", codexFinalResponse: "Synthetic", modelRole: "terra", modelId: "gpt-5.6-codex", reasoningEffort: "medium", conversationId: "00000000-0000-4000-8000-000000000003", turnId: "00000000-0000-4000-8000-000000000004", startedAt: "2026-08-26T12:00:00.000Z", finishedAt: "2026-08-26T12:00:00.000Z" }; }
async function digest(text) { const bytes = new TextEncoder().encode(text); const result = await crypto.subtle.digest("SHA-256", bytes); return [...new Uint8Array(result)].map((value) => value.toString(16).padStart(2, "0")).join(""); }
async function tick() { for (let index = 0; index < 6; index += 1) await Promise.resolve(); }
async function waitFor(predicate) { for (let index = 0; index < 20; index += 1) { if (predicate()) return; await new Promise((resolve) => setImmediate(resolve)); } throw new Error("Timed out waiting for browser client state"); }
