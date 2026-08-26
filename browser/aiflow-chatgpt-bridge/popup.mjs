import { browserTestPromptPayload } from "./protocol.mjs";
import { createReviewPopupActions, runtimeMessage, sanitizePopupState } from "./popupRuntime.mjs";

const $ = (id) => document.getElementById(id);
const send = (request, validate) => runtimeMessage((message) => chrome.runtime.sendMessage(message), request, validate);
const reviewActions = createReviewPopupActions({
  sendMessage: (request) => chrome.runtime.sendMessage(request),
  writeClipboard: (text) => navigator.clipboard.writeText(text),
  getPastedResponse: () => $("reviewResponse").value,
  clearPastedResponse: () => { $("reviewResponse").value = ""; },
  setStatus: (text) => { $("reviewStatus").textContent = text; },
});

async function render() {
  await send({ action: "restore" });
  renderState(sanitizePopupState(await send({ action: "status" })));
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
$("copyReviewRequest").addEventListener("click", async () => { if (await reviewActions.copyReviewRequest()) await render(); });
$("sendReviewDecision").addEventListener("click", async () => { if (await reviewActions.sendReviewDecision()) await render(); });
chrome.runtime.onMessage.addListener((event) => { if (event?.type === "bridge_state") { try { renderState(sanitizePopupState(event.state)); } catch { $("reviewStatus").textContent = "Browser bridge returned an invalid popup state"; } } });
void render();
