import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";

import { WebSocket, WebSocketServer } from "ws";

import {
  BROWSER_BRIDGE_ACK_TIMEOUT_MS,
  MAX_BROWSER_BRIDGE_MESSAGE_BYTES,
  createBrowserBridgeMessage,
  isChromeExtensionId,
  isChromeExtensionOrigin,
  parseBrowserBridgeMessage,
  reviewEnvelopeSha256,
  validateBrowserTestPromptPayload,
  type BrowserBridgeMessageV1,
} from "./browserBridgeProtocol";
import { validateImplementationReviewEnvelope, type ImplementationReviewEnvelopeV1 } from "./gitImplementationContracts";

const PAIRING_CODE_TTL_MS = 5 * 60_000;
const TOKEN_HASH_SECRET = "aiflow.browserBridge.browserTokenHash";
const EXTENSION_ID_SECRET = "aiflow.browserBridge.extensionId";

export interface BrowserBridgeSecretStorage {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export interface BrowserBridgeOptions {
  port: () => number;
  secrets: BrowserBridgeSecretStorage;
  serverFactory?: (options: { host: "127.0.0.1"; port: number; maxPayload: number }) => WebSocketServer;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  acknowledgementTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface BrowserBridgeStatus {
  serverState: "stopped" | "listening";
  port: number | null;
  pairedExtensionId: string | null;
  authenticated: boolean;
  latestTestPrompt: { messageId: string; utf8Bytes: number; sha256: string; receivedAt: string } | null;
}

export interface BrowserReviewDeliveryResult {
  bridgeMessageId: string;
  runId: string;
  envelopeSha256: string;
  acknowledgedAt: string;
}

interface PairingState {
  code: string;
  expiresAtMs: number;
  used: boolean;
}

interface ConnectedSocket {
  socket: WebSocket;
  origin: string | undefined;
  authenticated: boolean;
  extensionId: string | null;
}

interface PendingDelivery {
  messageId: string;
  runId: string;
  envelopeSha256: string;
  resolve: (value: BrowserReviewDeliveryResult) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export class BrowserBridge {
  private server: WebSocketServer | null = null;
  private listeningPort: number | null = null;
  private pairing: PairingState | null = null;
  private authenticated: ConnectedSocket | null = null;
  private pendingDelivery: PendingDelivery | null = null;
  private latestTestPrompt: BrowserBridgeStatus["latestTestPrompt"] = null;
  private pairedExtensionId: string | null = null;

  constructor(private readonly options: BrowserBridgeOptions) {}

  async beginPairing(): Promise<{ pairingCode: string; expiresAt: string }> {
    await this.ensureListening();
    const code = this.randomBytes(16).toString("hex");
    const expiresAt = new Date(this.now().getTime() + PAIRING_CODE_TTL_MS);
    this.pairing = { code, expiresAtMs: expiresAt.getTime(), used: false };
    return { pairingCode: code, expiresAt: expiresAt.toISOString() };
  }

  async revoke(): Promise<void> {
    this.pairing = null;
    await Promise.all([this.options.secrets.delete(TOKEN_HASH_SECRET), this.options.secrets.delete(EXTENSION_ID_SECRET)]);
    this.pairedExtensionId = null;
    this.closeAuthenticated(1008, "Pairing revoked");
    this.log("bridge pairing revoked");
  }

  async status(): Promise<BrowserBridgeStatus> {
    if (this.pairedExtensionId === null) {
      this.pairedExtensionId = (await this.options.secrets.get(EXTENSION_ID_SECRET)) ?? null;
    }
    return {
      serverState: this.server ? "listening" : "stopped",
      port: this.listeningPort,
      pairedExtensionId: this.pairedExtensionId,
      authenticated: this.authenticated !== null,
      latestTestPrompt: this.latestTestPrompt ? { ...this.latestTestPrompt } : null,
    };
  }

  async sendImplementationReviewEnvelope(envelope: unknown): Promise<BrowserReviewDeliveryResult> {
    validateImplementationReviewEnvelope(envelope);
    const client = this.authenticated;
    if (!client || client.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Browser bridge has no authenticated browser connection");
    }
    if (this.pendingDelivery) {
      throw new Error("Browser bridge already has a pending review delivery");
    }
    const envelopeSha256 = reviewEnvelopeSha256(envelope);
    const message = createBrowserBridgeMessage("implementation_review_envelope", envelope, () => this.now());
    const timeoutMs = this.options.acknowledgementTimeoutMs ?? BROWSER_BRIDGE_ACK_TIMEOUT_MS;
    const result = new Promise<BrowserReviewDeliveryResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingDelivery = null;
        reject(new Error("Timed out waiting for browser review acknowledgement"));
      }, timeoutMs);
      this.pendingDelivery = { messageId: message.id, runId: envelope.runId, envelopeSha256, resolve, reject, timeout };
    });
    try {
      this.send(client.socket, message);
      this.log(`review envelope: message=${message.id} run=${envelope.runId} sha256=${envelopeSha256}`);
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error("Browser review delivery failed"));
    }
    return result;
  }

  async dispose(): Promise<void> {
    this.pairing = null;
    this.closeAuthenticated(1001, "Bridge stopped");
    this.rejectPending(new Error("Browser bridge stopped"));
    const server = this.server;
    this.server = null;
    this.listeningPort = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async ensureListening(): Promise<void> {
    if (this.server) return;
    const port = this.options.port();
    const serverOptions = {
      host: "127.0.0.1",
      port,
      maxPayload: MAX_BROWSER_BRIDGE_MESSAGE_BYTES,
    } as const;
    const server = this.options.serverFactory?.(serverOptions) ?? new WebSocketServer(serverOptions);
    server.on("connection", (socket, request) => this.onConnection(socket, request.headers.origin));
    try {
      await Promise.race([
        once(server, "listening"),
        once(server, "error").then(([error]) => Promise.reject(error)),
      ]);
    } catch {
      server.close();
      throw new Error(`Browser bridge could not bind loopback port ${port}`);
    }
    this.server = server;
    const address = server.address();
    this.listeningPort = typeof address === "object" && address ? address.port : port;
    this.log(`bridge listening: 127.0.0.1:${this.listeningPort}`);
  }

  private onConnection(socket: WebSocket, origin: string | undefined): void {
    const connection: ConnectedSocket = { socket, origin, authenticated: false, extensionId: null };
    socket.on("message", (data, isBinary) => {
      void this.onMessage(connection, data, isBinary);
    });
    socket.on("close", () => {
      if (this.authenticated?.socket === socket) {
        this.authenticated = null;
        this.rejectPending(new Error("Authenticated browser disconnected"));
        this.log("browser disconnected");
      }
    });
    socket.on("error", () => undefined);
  }

  private async onMessage(connection: ConnectedSocket, data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): Promise<void> {
    if (isBinary) return this.rejectConnection(connection, "Binary frames are not supported");
    const raw = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    let message: BrowserBridgeMessageV1;
    try {
      message = parseBrowserBridgeMessage(raw);
    } catch (error) {
      return this.rejectConnection(connection, error instanceof Error ? error.message : "Invalid bridge message");
    }
    try {
      if (!connection.authenticated) {
        if (message.type === "pair_request") return await this.handlePairRequest(connection, message);
        if (message.type === "authenticate") return await this.handleAuthenticate(connection, message);
        throw new Error("Browser bridge requires pairing or authentication first");
      }
      await this.handleAuthenticatedMessage(connection, message);
    } catch (error) {
      this.sendError(connection.socket, message.id, error instanceof Error ? error.message : "Bridge request rejected");
      if (!connection.authenticated) connection.socket.close(1008, "Bridge authentication rejected");
    }
  }

  private async handlePairRequest(connection: ConnectedSocket, message: BrowserBridgeMessageV1): Promise<void> {
    if (!isRecord(message.payload) || !isChromeExtensionId(message.payload.extensionId) || typeof message.payload.pairingCode !== "string") {
      throw new Error("Invalid browser pairing request");
    }
    const extensionId = message.payload.extensionId;
    if (!isChromeExtensionOrigin(connection.origin, extensionId)) throw new Error("Browser bridge Origin is not an allowed extension");
    const pairing = this.pairing;
    if (!pairing || pairing.used || this.now().getTime() > pairing.expiresAtMs || !safeEquals(pairing.code, message.payload.pairingCode)) {
      throw new Error("Browser pairing code is invalid or expired");
    }
    pairing.used = true;
    this.pairing = null;
    const token = this.randomBytes(32).toString("hex");
    await this.options.secrets.store(TOKEN_HASH_SECRET, sha256(token));
    await this.options.secrets.store(EXTENSION_ID_SECRET, extensionId);
    this.pairedExtensionId = extensionId;
    this.send(connection.socket, createBrowserBridgeMessage("pair_success", { extensionId, browserToken: token }, () => this.now(), message.id));
    this.log(`browser paired: extension=${extensionId}`);
  }

  private async handleAuthenticate(connection: ConnectedSocket, message: BrowserBridgeMessageV1): Promise<void> {
    if (!isRecord(message.payload) || !isChromeExtensionId(message.payload.extensionId) || typeof message.payload.browserToken !== "string") {
      throw new Error("Invalid browser authentication request");
    }
    const extensionId = message.payload.extensionId;
    if (!isChromeExtensionOrigin(connection.origin, extensionId)) throw new Error("Browser bridge Origin is not an allowed extension");
    const [storedExtensionId, storedTokenHash] = await Promise.all([
      this.options.secrets.get(EXTENSION_ID_SECRET), this.options.secrets.get(TOKEN_HASH_SECRET),
    ]);
    if (!storedExtensionId || !storedTokenHash || storedExtensionId !== extensionId || !safeEquals(storedTokenHash, sha256(message.payload.browserToken))) {
      throw new Error("Browser authentication rejected");
    }
    if (this.authenticated && this.authenticated.socket !== connection.socket) {
      this.closeAuthenticated(1000, "Replaced by new authenticated browser connection");
    }
    connection.authenticated = true;
    connection.extensionId = extensionId;
    this.authenticated = connection;
    this.send(connection.socket, createBrowserBridgeMessage("authenticated", { extensionId }, () => this.now(), message.id));
    this.log(`browser authenticated: extension=${extensionId}`);
  }

  private async handleAuthenticatedMessage(connection: ConnectedSocket, message: BrowserBridgeMessageV1): Promise<void> {
    if (message.type === "ping") {
      this.send(connection.socket, createBrowserBridgeMessage("pong", {}, () => this.now(), message.id));
      return;
    }
    if (message.type === "browser_test_prompt") {
      validateBrowserTestPromptPayload(message.payload);
      const payload = message.payload;
      this.latestTestPrompt = { messageId: message.id, utf8Bytes: payload.utf8Bytes, sha256: payload.sha256, receivedAt: this.now().toISOString() };
      this.send(connection.socket, createBrowserBridgeMessage(
        "ack", { messageId: message.id, utf8Bytes: payload.utf8Bytes, sha256: payload.sha256 }, () => this.now(), message.id,
      ));
      this.log(`test prompt: message=${message.id} bytes=${payload.utf8Bytes} sha256=${payload.sha256}`);
      return;
    }
    if (message.type === "ack") return this.handleAcknowledgement(message);
    throw new Error("Browser bridge message type is not allowed after authentication");
  }

  private handleAcknowledgement(message: BrowserBridgeMessageV1): void {
    const pending = this.pendingDelivery;
    if (!pending || message.replyTo !== pending.messageId || !isRecord(message.payload) ||
        message.payload.runId !== pending.runId || message.payload.sha256 !== pending.envelopeSha256) {
      this.rejectPending(new Error("Browser review acknowledgement did not match the pending delivery"));
      return;
    }
    clearTimeout(pending.timeout);
    this.pendingDelivery = null;
    pending.resolve({ bridgeMessageId: pending.messageId, runId: pending.runId, envelopeSha256: pending.envelopeSha256, acknowledgedAt: this.now().toISOString() });
  }

  private send(socket: WebSocket, message: BrowserBridgeMessageV1): void {
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, "utf8") > MAX_BROWSER_BRIDGE_MESSAGE_BYTES) throw new Error("Browser bridge outbound message exceeds 1 MiB");
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Browser bridge connection is closed");
    socket.send(encoded);
  }

  private sendError(socket: WebSocket, replyTo: string, message: string): void {
    try { this.send(socket, createBrowserBridgeMessage("error", { message: message.slice(0, 300) }, () => this.now(), replyTo)); } catch { /* connection is already unusable */ }
  }

  private rejectConnection(connection: ConnectedSocket, message: string): void {
    this.sendError(connection.socket, createBrowserBridgeMessage("error", {}, () => this.now()).id, message);
    connection.socket.close(1008, "Bridge authentication or protocol rejected");
  }

  private closeAuthenticated(code: number, reason: string): void {
    const current = this.authenticated;
    this.authenticated = null;
    if (current && current.socket.readyState === WebSocket.OPEN) current.socket.close(code, reason);
  }

  private rejectPending(error: Error): void {
    const pending = this.pendingDelivery;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingDelivery = null;
    pending.reject(error);
  }

  private now(): Date { return (this.options.now ?? (() => new Date()))(); }
  private randomBytes(size: number): Buffer { return (this.options.randomBytes ?? randomBytes)(size); }
  private log(message: string): void { this.options.log?.(message); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
