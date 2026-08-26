import { browserTestPromptPayload } from "./protocol.mjs";

const $ = (id) => document.getElementById(id);
const send = (request) => chrome.runtime.sendMessage(request);

async function render() {
  await send({ action: "connect" });
  const state = await send({ action: "status" });
  $("status").textContent = `${state.authenticated ? "Authenticated" : "Disconnected"} · localhost:${state.port}`;
  $("port").value = state.port;
  const envelope = state.latestEnvelope;
  $("summary").textContent = envelope ? `${envelope.runId}\n${envelope.githubRepository} · ${envelope.branch}\n${envelope.headSha}\n${envelope.deliveryStatus} · push ${envelope.pushVerified}\n${envelope.codexOutcome} · ${envelope.modelRole}/${envelope.reasoningEffort}` : "None";
  $("envelope").textContent = envelope ? JSON.stringify(envelope, null, 2) : "";
}

$("pair").addEventListener("click", async () => { await send({ action: "pair", pairingCode: $("pairingCode").value }); });
$("savePort").addEventListener("click", async () => { await send({ action: "setPort", port: Number($("port").value) }); await render(); });
$("connect").addEventListener("click", async () => { const state = await send({ action: "status" }); await send({ action: state.connected ? "disconnect" : "connect" }); await render(); });
$("revoke").addEventListener("click", async () => { await send({ action: "revoke" }); await render(); });
$("prompt").addEventListener("input", async () => { try { const payload = await browserTestPromptPayload($("prompt").value); $("metrics").textContent = `${payload.utf8Bytes} UTF-8 bytes · ${payload.sha256}`; } catch (error) { $("metrics").textContent = error.message; } });
$("sendPrompt").addEventListener("click", async () => { await send({ action: "sendPrompt", text: $("prompt").value }); $("prompt").value = ""; await render(); });
void render();
