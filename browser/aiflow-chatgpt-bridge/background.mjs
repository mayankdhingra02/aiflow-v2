import { browserTestPromptPayload, message, sha256, validateMessage, validateReviewEnvelope } from "./protocol.mjs";

const DEFAULT_PORT = 47323;
let socket = null;
let authenticated = false;
let reconnectTimer = null;
let blocked = false;

async function settings() {
  return chrome.storage.local.get({ port: DEFAULT_PORT, extensionId: null, browserToken: null, latestEnvelope: null });
}

function status() { return { connected: socket?.readyState === WebSocket.OPEN, authenticated, blocked }; }

function scheduleReconnect() {
  if (blocked || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, 1_000);
}

export async function connect() {
  const { port, extensionId, browserToken } = await settings();
  if (blocked || !extensionId || !browserToken || socket?.readyState === WebSocket.OPEN) return status();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => send(message("authenticate", { extensionId, browserToken })));
  socket.addEventListener("close", () => { authenticated = false; scheduleReconnect(); });
  socket.addEventListener("error", () => undefined);
  socket.addEventListener("message", (event) => { void receive(event.data); });
  return status();
}

function send(value) {
  const encoded = JSON.stringify(value);
  if (!socket || socket.readyState !== WebSocket.OPEN || new TextEncoder().encode(encoded).byteLength > 1_048_576) throw new Error("Bridge is disconnected");
  socket.send(encoded);
}

async function receive(raw) {
  let incoming;
  try { incoming = validateMessage(JSON.parse(raw)); } catch { socket?.close(); return; }
  if (incoming.type === "error") { blocked = true; socket?.close(); return; }
  if (incoming.type === "pair_success") {
    const { extensionId, browserToken } = incoming.payload ?? {};
    if (typeof extensionId !== "string" || typeof browserToken !== "string") { socket?.close(); return; }
    await chrome.storage.local.set({ extensionId, browserToken });
    socket?.close();
    blocked = false;
    void connect();
    return;
  }
  if (incoming.type === "authenticated") { authenticated = true; return; }
  if (incoming.type === "implementation_review_envelope") {
    try {
      const envelope = validateReviewEnvelope(incoming.payload);
      await chrome.storage.local.set({ latestEnvelope: envelope });
      send(message("ack", { runId: envelope.runId, sha256: await sha256(JSON.stringify(envelope)) }, incoming.id));
    } catch { socket?.close(); }
  }
}

export async function pair(pairingCode) {
  blocked = false;
  const { port } = await settings();
  socket?.close();
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => send(message("pair_request", { extensionId: chrome.runtime.id, pairingCode })));
  socket.addEventListener("message", (event) => { void receive(event.data); });
  socket.addEventListener("close", () => { authenticated = false; scheduleReconnect(); });
}

export async function sendTestPrompt(text) {
  if (!authenticated) throw new Error("Browser bridge is not authenticated");
  send(message("browser_test_prompt", await browserTestPromptPayload(text)));
}

export async function revokeLocalToken() {
  blocked = true;
  socket?.close();
  socket = null;
  authenticated = false;
  await chrome.storage.local.remove(["extensionId", "browserToken"]);
}

export function disconnect() {
  socket?.close();
  socket = null;
  authenticated = false;
}

export async function setPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be an integer from 1024 through 65535");
  disconnect();
  await chrome.storage.local.set({ port });
}

chrome.runtime.onStartup.addListener(() => { void connect(); });
chrome.runtime.onMessage.addListener((request, _sender, reply) => {
  void (async () => {
    try {
      if (request.action === "status") reply({ ...status(), ...(await settings()) });
      else if (request.action === "connect") reply(await connect());
      else if (request.action === "disconnect") { disconnect(); reply({ ok: true }); }
      else if (request.action === "setPort") { await setPort(request.port); reply({ ok: true }); }
      else if (request.action === "pair") { await pair(request.pairingCode); reply({ ok: true }); }
      else if (request.action === "sendPrompt") { await sendTestPrompt(request.text); reply({ ok: true }); }
      else if (request.action === "revoke") { await revokeLocalToken(); reply({ ok: true }); }
      else reply({ error: "Unsupported action" });
    } catch (error) { reply({ error: String(error.message ?? error).slice(0, 300) }); }
  })();
  return true;
});
