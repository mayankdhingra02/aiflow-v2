import { MAX_MESSAGE_BYTES, browserTestPromptPayload, createReviewRequest as createHandoffRequest, message, parseInbound, parseReviewDecisionText, reviewDecisionDigest, reviewEnvelopeDigest, serializeReviewRequest, validateReviewEnvelope } from "./protocol.mjs";

const DEFAULT_PORT = 47323;
const ACK_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export class BrowserBridgeClient {
  constructor(dependencies) {
    this.deps = dependencies;
    this.socket = null;
    this.state = "disconnected";
    this.sequence = 0;
    this.reconnectTimer = null;
    this.heartbeatInterval = null;
    this.heartbeatTimeout = null;
    this.promptAck = null;
    this.reviewRequestAck = null;
    this.reviewDecisionAck = null;
    this.pendingPair = null;
    this.pendingAuthentication = null;
    this.pendingPing = null;
    this.retry = 0;
  }

  async connect(explicit = false) {
    let stored = await this.settings();
    if (explicit && stored.manualDisconnected) {
      await this.deps.storage.set({ manualDisconnected: false });
      stored = await this.settings();
    }
    if (stored.manualDisconnected || this.state === "blocked") return this.publish();
    if (!stored.extensionId || !stored.browserToken) return this.setState("disconnected");
    if (this.socket && (this.socket.readyState === this.deps.WebSocket.OPEN || this.socket.readyState === this.deps.WebSocket.CONNECTING)) return this.publish();
    return this.open("authenticate", stored);
  }

  async pair(pairingCode) {
    if (typeof pairingCode !== "string" || !pairingCode) throw new Error("Pairing code is required");
    await this.deps.storage.set({ manualDisconnected: false });
    this.state = "pairing";
    this.retry = 0;
    this.closeSocket(true);
    const stored = await this.settings();
    return this.open("pair", { ...stored, pairingCode });
  }

  async disconnect() {
    await this.deps.storage.set({ manualDisconnected: true });
    this.state = "manually_disconnected";
    this.closeSocket(true);
    return this.publish();
  }

  async revoke() {
    await this.deps.storage.remove(["extensionId", "browserToken"]);
    await this.deps.storage.set({ manualDisconnected: true });
    this.state = "manually_disconnected";
    this.closeSocket(true);
    return this.publish();
  }

  async setPort(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be an integer from 1024 through 65535");
    await this.deps.storage.set({ port, manualDisconnected: true });
    this.state = "manually_disconnected";
    this.closeSocket(true);
    return this.publish();
  }

  async sendTestPrompt(text) {
    if (this.state !== "authenticated" || !this.socket || this.promptAck) throw new Error("Browser bridge is not ready for a test prompt");
    const payload = await browserTestPromptPayload(text);
    const outgoing = this.send("browser_test_prompt", payload);
    return new Promise((resolve, reject) => {
      const timeout = this.deps.setTimeout(() => this.rejectPromptAck(new Error("Timed out waiting for test prompt acknowledgement")), ACK_TIMEOUT_MS);
      this.promptAck = { id: outgoing.id, utf8Bytes: payload.utf8Bytes, sha256: payload.sha256, resolve, reject, timeout };
    });
  }

  async createReviewRequest() {
    if (this.state !== "authenticated" || !this.socket || this.reviewRequestAck || this.reviewDecisionAck) throw new Error("Browser bridge is not ready for a review request");
    const stored = await this.settings();
    const envelope = validateReviewEnvelope(stored.latestEnvelope);
    const envelopeSha256 = await reviewEnvelopeDigest(envelope);
    const metadata = stored.latestReviewRequest;
    if (metadata && metadata.runId === envelope.runId && metadata.envelopeSha256 === envelopeSha256) {
      return serializeReviewRequest({ version: 1, ...metadata, implementationReviewEnvelope: envelope });
    }
    const request = await (this.deps.createReviewRequest ?? createHandoffRequest)(envelope, { now: this.deps.now, uuid: this.deps.uuid });
    const serialized = (this.deps.serializeReviewRequest ?? serializeReviewRequest)(request);
    const outgoing = this.send("review_request", request);
    await new Promise((resolve, reject) => {
      const timeout = this.deps.setTimeout(() => this.rejectReviewRequestAck(new Error("Timed out waiting for review request acknowledgement")), ACK_TIMEOUT_MS);
      this.reviewRequestAck = { id: outgoing.id, request, resolve, reject, timeout };
    });
    await this.deps.storage.set({ latestReviewRequest: { requestId: request.requestId, runId: request.runId, envelopeSha256: request.envelopeSha256, createdAt: request.createdAt } });
    return serialized;
  }

  async sendReviewDecision(raw) {
    if (this.state !== "authenticated" || !this.socket || this.reviewDecisionAck || this.reviewRequestAck) throw new Error("Browser bridge is not ready for a review decision");
    const stored = await this.settings();
    const metadata = stored.latestReviewRequest;
    const envelope = validateReviewEnvelope(stored.latestEnvelope);
    if (!metadata || metadata.runId !== envelope.runId || metadata.envelopeSha256 !== await reviewEnvelopeDigest(envelope)) throw new Error("No current acknowledged review request is available");
    if (stored.latestReviewDecision && stored.latestReviewDecision.requestId === metadata.requestId && stored.latestReviewDecision.runId === metadata.runId && stored.latestReviewDecision.envelopeSha256 === metadata.envelopeSha256) {
      throw new Error("This review request already has an acknowledged decision");
    }
    const request = { version: 1, ...metadata, implementationReviewEnvelope: envelope };
    const decision = parseReviewDecisionText(raw, request, this.deps.now);
    const decisionSha256 = await reviewDecisionDigest(decision);
    const outgoing = this.send("review_decision", decision);
    const acknowledgement = await new Promise((resolve, reject) => {
      const timeout = this.deps.setTimeout(() => this.rejectReviewDecisionAck(new Error("Timed out waiting for review decision acknowledgement")), ACK_TIMEOUT_MS);
      this.reviewDecisionAck = { id: outgoing.id, decision, decisionSha256, resolve, reject, timeout };
    });
    await this.deps.storage.set({ latestReviewDecision: { requestId: decision.requestId, runId: decision.runId, envelopeSha256: decision.envelopeSha256, verdict: decision.verdict, ...(decision.verdict === "CHANGES_REQUESTED" ? { modelRole: decision.modelRole, reasoningEffort: decision.reasoningEffort } : {}), decisionSha256, acknowledgedAt: acknowledgement.acknowledgedAt } });
    await this.publish();
    return acknowledgement;
  }

  async status() { return this.safeStatus(await this.settings()); }

  async open(kind, stored) {
    if (this.socket && (this.socket.readyState === this.deps.WebSocket.OPEN || this.socket.readyState === this.deps.WebSocket.CONNECTING)) return this.publish();
    const sequence = ++this.sequence;
    const socket = new this.deps.WebSocket(`ws://127.0.0.1:${stored.port}`);
    this.socket = socket;
    this.state = "connecting";
    socket.addEventListener("open", () => { void this.onOpen(socket, sequence, kind, stored); });
    socket.addEventListener("message", (event) => { void this.onMessage(socket, sequence, event.data); });
    socket.addEventListener("close", () => { void this.onClose(socket, sequence); });
    socket.addEventListener("error", () => undefined);
    return this.publish();
  }

  async onOpen(socket, sequence, kind, stored) {
    if (!this.current(socket, sequence)) return;
    try {
      if (kind === "pair") {
        this.state = "pairing";
        this.pendingPair = this.send("pair_request", { extensionId: this.deps.extensionId, pairingCode: stored.pairingCode });
      } else {
        this.state = "authenticating";
        this.pendingAuthentication = this.send("authenticate", { extensionId: stored.extensionId, browserToken: stored.browserToken });
      }
      await this.publish();
    } catch (error) { await this.block(error); }
  }

  async onMessage(socket, sequence, raw) {
    if (!this.current(socket, sequence)) return;
    let incoming;
    try { incoming = parseInbound(raw); } catch (error) { return this.failProtocol(error); }
    try {
      if (incoming.type === "error") return await this.block(new Error("Browser bridge rejected the request"));
      if (incoming.type === "pair_success") return await this.handlePairSuccess(incoming);
      if (incoming.type === "authenticated") return await this.handleAuthenticated(incoming);
      if (incoming.type === "ack") return await this.handleAcknowledgement(incoming);
      if (incoming.type === "pong") return await this.handlePong(incoming);
      if (incoming.type === "implementation_review_envelope") return await this.handleEnvelope(incoming);
      throw new Error("Unexpected browser bridge message state");
    } catch (error) { return this.failProtocol(error); }
  }

  async handlePairSuccess(incoming) {
    if (this.state !== "pairing" || !this.pendingPair || incoming.replyTo !== this.pendingPair.id || !isRecord(incoming.payload) || incoming.payload.extensionId !== this.deps.extensionId || typeof incoming.payload.browserToken !== "string") throw new Error("Uncorrelated browser pairing response");
    this.pendingPair = null;
    await this.deps.storage.set({ extensionId: this.deps.extensionId, browserToken: incoming.payload.browserToken, manualDisconnected: false });
    this.closeSocket(true);
    this.state = "disconnected";
    return this.connect();
  }

  async handleAuthenticated(incoming) {
    if (this.state !== "authenticating" || !this.pendingAuthentication || incoming.replyTo !== this.pendingAuthentication.id || !isRecord(incoming.payload) || incoming.payload.extensionId !== this.deps.extensionId) throw new Error("Uncorrelated browser authentication response");
    this.pendingAuthentication = null;
    this.state = "authenticated";
    this.retry = 0;
    this.startHeartbeat();
    return this.publish();
  }

  async handlePromptAcknowledgement(incoming) {
    const pending = this.promptAck;
    if (!pending || incoming.replyTo !== pending.id || !isRecord(incoming.payload) || incoming.payload.messageId !== pending.id || incoming.payload.utf8Bytes !== pending.utf8Bytes || incoming.payload.sha256 !== pending.sha256) throw new Error("Test prompt acknowledgement did not match the pending prompt");
    this.deps.clearTimeout(pending.timeout);
    this.promptAck = null;
    const acknowledgement = { messageId: pending.id, utf8Bytes: pending.utf8Bytes, sha256: pending.sha256, acknowledgedAt: this.deps.now().toISOString() };
    await this.deps.storage.set({ latestPromptAcknowledgement: acknowledgement });
    pending.resolve(acknowledgement);
    await this.publish();
  }

  async handleAcknowledgement(incoming) {
    if (this.promptAck) return this.handlePromptAcknowledgement(incoming);
    if (this.reviewRequestAck) return this.handleReviewRequestAcknowledgement(incoming);
    if (this.reviewDecisionAck) return this.handleReviewDecisionAcknowledgement(incoming);
    throw new Error("Unexpected browser bridge acknowledgement");
  }

  async handleReviewRequestAcknowledgement(incoming) {
    const pending = this.reviewRequestAck;
    if (!pending || incoming.replyTo !== pending.id || !isRecord(incoming.payload) || incoming.payload.requestId !== pending.request.requestId || incoming.payload.runId !== pending.request.runId || incoming.payload.envelopeSha256 !== pending.request.envelopeSha256) throw new Error("Review request acknowledgement did not match the pending request");
    this.deps.clearTimeout(pending.timeout);
    this.reviewRequestAck = null;
    pending.resolve({ requestId: pending.request.requestId, runId: pending.request.runId, envelopeSha256: pending.request.envelopeSha256, acknowledgedAt: this.deps.now().toISOString() });
  }

  async handleReviewDecisionAcknowledgement(incoming) {
    const pending = this.reviewDecisionAck;
    if (!pending || incoming.replyTo !== pending.id || !isRecord(incoming.payload) || incoming.payload.requestId !== pending.decision.requestId || incoming.payload.runId !== pending.decision.runId || incoming.payload.envelopeSha256 !== pending.decision.envelopeSha256 || incoming.payload.verdict !== pending.decision.verdict || incoming.payload.decisionSha256 !== pending.decisionSha256) throw new Error("Review decision acknowledgement did not match the pending decision");
    this.deps.clearTimeout(pending.timeout);
    this.reviewDecisionAck = null;
    pending.resolve({ requestId: pending.decision.requestId, runId: pending.decision.runId, envelopeSha256: pending.decision.envelopeSha256, verdict: pending.decision.verdict, decisionSha256: pending.decisionSha256, acknowledgedAt: this.deps.now().toISOString() });
  }

  async handleEnvelope(incoming) {
    if (this.state !== "authenticated") throw new Error("Review envelope received before authentication");
    const envelope = validateReviewEnvelope(incoming.payload);
    await this.deps.storage.set({ latestEnvelope: envelope, latestReviewRequest: null, latestReviewDecision: null });
    this.send("ack", { runId: envelope.runId, sha256: await reviewEnvelopeDigest(envelope) }, incoming.id);
    return this.publish();
  }

  handlePong(incoming) {
    if (!this.pendingPing || incoming.replyTo !== this.pendingPing.id) throw new Error("Uncorrelated browser bridge heartbeat response");
    this.deps.clearTimeout(this.heartbeatTimeout);
    this.heartbeatTimeout = null;
    this.pendingPing = null;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = this.deps.setInterval(() => {
      if (this.state !== "authenticated") return;
      if (this.pendingPing) return this.failProtocol(new Error("Browser bridge heartbeat timed out"));
      const ping = this.send("ping", {});
      this.pendingPing = ping;
      this.heartbeatTimeout = this.deps.setTimeout(() => this.failProtocol(new Error("Browser bridge heartbeat timed out")), HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) this.deps.clearInterval(this.heartbeatInterval);
    if (this.heartbeatTimeout) this.deps.clearTimeout(this.heartbeatTimeout);
    this.heartbeatInterval = null;
    this.heartbeatTimeout = null;
    this.pendingPing = null;
  }

  async onClose(socket, sequence) {
    if (!this.current(socket, sequence)) return;
    this.socket = null;
    this.stopHeartbeat();
    this.rejectPromptAck(new Error("Browser bridge connection closed"));
    this.rejectReviewRequestAck(new Error("Browser bridge connection closed"));
    this.rejectReviewDecisionAck(new Error("Browser bridge connection closed"));
    this.pendingPair = null;
    this.pendingAuthentication = null;
    const stored = await this.settings();
    if (stored.manualDisconnected || this.state === "blocked" || this.state === "manually_disconnected") return this.setState(stored.manualDisconnected ? "manually_disconnected" : this.state);
    await this.setState("disconnected");
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.state === "blocked") return;
    const delay = Math.min(1_000 * (2 ** this.retry++), 10_000);
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => { void this.handleReconnectFailure(error); });
    }, delay);
  }

  closeSocket(intentional) {
    if (this.reconnectTimer) this.deps.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === this.deps.WebSocket.OPEN || socket.readyState === this.deps.WebSocket.CONNECTING)) socket.close();
    if (intentional) this.sequence++;
  }

  send(type, payload, replyTo) {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.deps.WebSocket.OPEN) throw new Error("Browser bridge is disconnected");
    const outgoing = message(type, payload, replyTo, { now: this.deps.now, uuid: this.deps.uuid });
    const encoded = JSON.stringify(outgoing);
    if (new TextEncoder().encode(encoded).byteLength > MAX_MESSAGE_BYTES) throw new Error("Browser bridge message exceeds 1 MiB");
    socket.send(encoded);
    return outgoing;
  }

  rejectPendingOperations(error) {
    const rejected = error instanceof Error ? error : new Error("Browser protocol rejected");
    this.rejectPromptAck(rejected);
    this.rejectReviewRequestAck(rejected);
    this.rejectReviewDecisionAck(rejected);
  }
  async failProtocol(error) {
    this.rejectPendingOperations(error);
    this.closeSocket(false);
    await this.setState("disconnected", error);
    const stored = await this.settings();
    if (!stored.manualDisconnected && this.state !== "blocked") this.scheduleReconnect();
  }
  async handleReconnectFailure(error) {
    try {
      await this.setState("disconnected", error);
      const stored = await this.settings();
      if (!stored.manualDisconnected && this.state !== "blocked") this.scheduleReconnect();
    } catch {
      this.state = "disconnected";
    }
  }
  async block(error) { this.rejectPendingOperations(error); this.closeSocket(true); return this.setState("blocked", error); }
  async setState(state, error) { this.state = state; return this.publish(error); }
  async publish(error) { const state = await this.status(); this.deps.notify({ type: "bridge_state", state, ...(error ? { error: bounded(error) } : {}) }); return state; }
  async settings() { return this.deps.storage.get({ port: DEFAULT_PORT, extensionId: null, browserToken: null, latestEnvelope: null, latestPromptAcknowledgement: null, latestReviewRequest: null, latestReviewDecision: null, manualDisconnected: false }); }
  async safeStatus(stored) { return { state: this.state, connected: this.socket?.readyState === this.deps.WebSocket.OPEN, authenticated: this.state === "authenticated", port: stored.port, pairedExtensionId: stored.extensionId, latestEnvelope: stored.latestEnvelope, latestPromptAcknowledgement: stored.latestPromptAcknowledgement, latestReviewRequest: stored.latestReviewRequest, latestReviewDecision: stored.latestReviewDecision, manualDisconnected: Boolean(stored.manualDisconnected) }; }
  current(socket, sequence) { return this.socket === socket && this.sequence === sequence; }
  rejectPromptAck(error) { if (!this.promptAck) return; const pending = this.promptAck; this.promptAck = null; this.deps.clearTimeout(pending.timeout); pending.reject(error); }
  rejectReviewRequestAck(error) { if (!this.reviewRequestAck) return; const pending = this.reviewRequestAck; this.reviewRequestAck = null; this.deps.clearTimeout(pending.timeout); pending.reject(error); }
  rejectReviewDecisionAck(error) { if (!this.reviewDecisionAck) return; const pending = this.reviewDecisionAck; this.reviewDecisionAck = null; this.deps.clearTimeout(pending.timeout); pending.reject(error); }
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded(error) { return String(error?.message ?? error).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); }
