import { browserTestPromptPayload } from "./protocol.mjs";

const $ = (id) => document.getElementById(id);
const send = (request) => chrome.runtime.sendMessage(request);

async function render() {
  await send({ action: "restore" });
  renderState(await send({ action: "status" }));
}

function renderState(state) {
  $("status").textContent = `${state.authenticated ? "Authenticated" : "Disconnected"} · localhost:${state.port}`;
  $("port").value = state.port;
  if (state.latestPromptAcknowledgement) $("metrics").textContent = `Acknowledged: ${state.latestPromptAcknowledgement.utf8Bytes} UTF-8 bytes · ${state.latestPromptAcknowledgement.sha256}`;
  const envelope = state.latestEnvelope;
  $("summary").textContent = envelope ? `${envelope.runId}\n${envelope.githubRepository} · ${envelope.branch}\n${envelope.headSha}\n${envelope.deliveryStatus} · push ${envelope.pushVerified}\n${envelope.codexOutcome} · ${envelope.modelRole}/${envelope.reasoningEffort}` : "None";
  $("envelope").textContent = envelope ? JSON.stringify(envelope, null, 2) : "";
  const request = state.latestReviewRequest;
  const decision = state.latestReviewDecision;
  $("reviewMeta").textContent = request ? `Request: ${request.requestId}\nRun: ${request.runId}\nEnvelope SHA-256: ${request.envelopeSha256}` : "No generated review request.";
  $("reviewStatus").textContent = decision ? `Accepted ${decision.verdict} · acknowledged ${decision.acknowledgedAt}` : "";
}

$("pair").addEventListener("click", async () => { await send({ action: "pair", pairingCode: $("pairingCode").value }); });
$("savePort").addEventListener("click", async () => { await send({ action: "setPort", port: Number($("port").value) }); await render(); });
$("connect").addEventListener("click", async () => { const state = await send({ action: "status" }); await send({ action: state.connected ? "disconnect" : "connect" }); await render(); });
$("revoke").addEventListener("click", async () => { await send({ action: "revoke" }); await render(); });
$("prompt").addEventListener("input", async () => { try { const payload = await browserTestPromptPayload($("prompt").value); $("metrics").textContent = `${payload.utf8Bytes} UTF-8 bytes · ${payload.sha256}`; } catch (error) { $("metrics").textContent = error.message; } });
$("sendPrompt").addEventListener("click", async () => { const acknowledgement = await send({ action: "sendPrompt", text: $("prompt").value }); $("metrics").textContent = `Acknowledged: ${acknowledgement.utf8Bytes} UTF-8 bytes · ${acknowledgement.sha256}`; $("prompt").value = ""; await render(); });
$("copyReviewRequest").addEventListener("click", async () => {
  try {
    const request = await send({ action: "createReviewRequest" });
    await navigator.clipboard.writeText(request);
    $("reviewStatus").textContent = "Review request copied. Paste it manually into ChatGPT.";
    await render();
  } catch (error) { $("reviewStatus").textContent = `Copy unavailable: ${String(error?.message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 200)}`; }
});
$("sendReviewDecision").addEventListener("click", async () => {
  try {
    const acknowledgement = await send({ action: "sendReviewDecision", text: $("reviewResponse").value });
    $("reviewResponse").value = "";
    $("reviewStatus").textContent = `Accepted ${acknowledgement.verdict} · acknowledged ${acknowledgement.acknowledgedAt}`;
    await render();
  } catch (error) { $("reviewStatus").textContent = `Review rejected: ${String(error?.message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 200)}`; }
});
chrome.runtime.onMessage.addListener((event) => { if (event?.type === "bridge_state") renderState(event.state); });
void render();
