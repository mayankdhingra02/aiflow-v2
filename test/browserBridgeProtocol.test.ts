import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_BROWSER_BRIDGE_PORT,
  MAX_BROWSER_BRIDGE_MESSAGE_BYTES,
  MAX_BROWSER_TEST_PROMPT_BYTES,
  BrowserBridgeError,
  parseBrowserBridgeMessage,
  resolveBrowserBridgePort,
  sha256Hex,
  validateBrowserBridgeMessage,
  validateBrowserTestPromptPayload,
} from "../src/browserBridgeProtocol";

test("browser bridge port configuration is loopback-safe and bounded", () => {
  assert.equal(resolveBrowserBridgePort(undefined), DEFAULT_BROWSER_BRIDGE_PORT);
  assert.equal(resolveBrowserBridgePort(1024), 1024);
  assert.equal(resolveBrowserBridgePort(65535), 65535);
  for (const value of [1023, 65536, 47323.5, Number.NaN, Infinity]) {
    assert.throws(() => resolveBrowserBridgePort(value), (error: unknown) =>
      error instanceof BrowserBridgeError && error.code === "INVALID_CONFIGURATION" && error.message.length <= 400,
    );
  }
});

test("browser bridge protocol rejects malformed, oversized, version-invalid, UUID-invalid, and timestamp-invalid messages", () => {
  assert.throws(() => parseBrowserBridgeMessage("{"), /not valid JSON/);
  assert.throws(() => parseBrowserBridgeMessage("x".repeat(MAX_BROWSER_BRIDGE_MESSAGE_BYTES + 1)), /exceeds 1 MiB/);
  for (const value of [
    { version: 2, id: "00000000-0000-4000-8000-000000000001", type: "ping", sentAt: new Date().toISOString(), payload: {} },
    { version: 1, id: "not-a-uuid", type: "ping", sentAt: new Date().toISOString(), payload: {} },
    { version: 1, id: "00000000-0000-4000-8000-000000000001", type: "ping", sentAt: "no", payload: {} },
  ]) assert.throws(() => validateBrowserBridgeMessage(value), /invalid protocol fields/);
});

test("browser test prompt preserves exact Unicode and validates bytes and SHA-256", () => {
  const text = "AIFLOW_BRIDGE_TEST_🙂\nsecond line";
  const payload = { text, utf8Bytes: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text) };
  assert.doesNotThrow(() => validateBrowserTestPromptPayload(payload));
  assert.throws(() => validateBrowserTestPromptPayload({ ...payload, utf8Bytes: payload.utf8Bytes - 1 }), /byte count or SHA-256/);
  assert.throws(() => validateBrowserTestPromptPayload({ ...payload, sha256: "0".repeat(64) }), /byte count or SHA-256/);
  assert.doesNotThrow(() => validateBrowserTestPromptPayload({ text: "a".repeat(MAX_BROWSER_TEST_PROMPT_BYTES), utf8Bytes: MAX_BROWSER_TEST_PROMPT_BYTES, sha256: sha256Hex("a".repeat(MAX_BROWSER_TEST_PROMPT_BYTES)) }));
  assert.throws(() => validateBrowserTestPromptPayload({ text: "a".repeat(MAX_BROWSER_TEST_PROMPT_BYTES + 1), utf8Bytes: MAX_BROWSER_TEST_PROMPT_BYTES + 1, sha256: sha256Hex("a".repeat(MAX_BROWSER_TEST_PROMPT_BYTES + 1)) }));
});
