import { BrowserBridgeClient } from "./client.mjs";
import { createBrowserRuntimeTimers } from "./runtime.mjs";

const client = new BrowserBridgeClient({
  WebSocket,
  extensionId: chrome.runtime.id,
  storage: chrome.storage.local,
  now: () => new Date(),
  uuid: () => crypto.randomUUID(),
  ...createBrowserRuntimeTimers(globalThis),
  notify: (event) => { void chrome.runtime.sendMessage(event).catch(() => undefined); },
});

chrome.runtime.onStartup.addListener(() => { void client.connect(); });
chrome.runtime.onMessage.addListener((request, _sender, reply) => {
  if (request?.type === "bridge_state") return false;
  void (async () => {
    try {
      if (request.action === "status") reply(await client.status());
      else if (request.action === "connect") reply(await client.connect(true));
      else if (request.action === "restore") reply(await client.connect());
      else if (request.action === "disconnect") reply(await client.disconnect());
      else if (request.action === "setPort") reply(await client.setPort(request.port));
      else if (request.action === "pair") reply(await client.pair(request.pairingCode));
      else if (request.action === "sendPrompt") reply(await client.sendTestPrompt(request.text));
      else if (request.action === "createReviewRequest") reply(await client.createReviewRequest());
      else if (request.action === "sendReviewDecision") reply(await client.sendReviewDecision(request.text));
      else if (request.action === "revoke") reply(await client.revoke());
      else reply({ error: "Unsupported action" });
    } catch (error) { reply({ error: String(error?.message ?? error).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) }); }
  })();
  return true;
});
