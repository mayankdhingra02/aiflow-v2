import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { browserTestPromptPayload, validateMessage } from "../protocol.mjs";

test("browser protocol preserves Unicode prompt bytes and digest", async () => {
  const payload = await browserTestPromptPayload("AIFLOW_BRIDGE_TEST_🙂\nsecond line");
  assert.equal(payload.utf8Bytes, new TextEncoder().encode(payload.text).byteLength);
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
});

test("browser protocol rejects invalid envelope message timestamps", () => {
  assert.throws(() => validateMessage({ version: 1, id: "00000000-0000-4000-8000-000000000001", type: "ping", sentAt: "not-a-date", payload: {} }));
});

test("browser extension has no ChatGPT permission or content script", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.equal(JSON.stringify(manifest).includes("chatgpt.com"), false);
  assert.equal("content_scripts" in manifest, false);
  assert.deepEqual(manifest.permissions, ["storage"]);
});
