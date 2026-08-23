import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FrameDecoder,
  RequestCorrelator,
  createRequest,
  encodeFrame,
  type IpcSuccessResponse,
} from "../src/protocol";

test("length-prefixed IPC framing uses four-byte little-endian JSON frames", () => {
  const message = { type: "response", requestId: "one", resultType: "success" };
  const frame = encodeFrame(message);

  assert.equal(frame.readUInt32LE(0), Buffer.byteLength(JSON.stringify(message), "utf8"));
  assert.deepEqual(new FrameDecoder().push(frame), [message]);
});

test("frame decoder handles fragmented frames", () => {
  const message = { type: "response", requestId: "fragmented", resultType: "success" };
  const frame = encodeFrame(message);
  const decoder = new FrameDecoder();
  const decoded = [];

  for (const byte of frame) {
    decoded.push(...decoder.push(Buffer.from([byte])));
  }
  assert.deepEqual(decoded, [message]);
});

test("frame decoder handles combined frames", () => {
  const first = { type: "response", requestId: "first", resultType: "success" };
  const second = { type: "response", requestId: "second", resultType: "error" };
  const decoded = new FrameDecoder().push(Buffer.concat([encodeFrame(first), encodeFrame(second)]));

  assert.deepEqual(decoded, [first, second]);
});

test("request correlator resolves responses by request ID even out of order", async () => {
  const correlator = new RequestCorrelator();
  const firstPromise = correlator.wait("first", "one", 1_000);
  const secondPromise = correlator.wait("second", "two", 1_000);
  const second: IpcSuccessResponse = {
    type: "response",
    requestId: "second",
    resultType: "success",
    method: "two",
    handledByClientId: "owner",
    result: { order: 2 },
  };
  const first: IpcSuccessResponse = {
    type: "response",
    requestId: "first",
    resultType: "success",
    method: "one",
    handledByClientId: "owner",
    result: { order: 1 },
  };

  assert.equal(correlator.resolve(second), true);
  assert.equal(correlator.resolve(first), true);
  assert.deepEqual(await firstPromise, first);
  assert.deepEqual(await secondPromise, second);
});

test("request correlator times out with a bounded method-specific error", async () => {
  const correlator = new RequestCorrelator();
  await assert.rejects(correlator.wait("lost", "thread-owner-discovery", 5), {
    message: "IPC request timed out: thread-owner-discovery",
  });
});

test("private request envelopes contain the confirmed protocol versions", () => {
  const initialize = createRequest(
    "initializing-client",
    "initialize",
    { clientType: "vscode" },
    { requestId: "init" },
  );
  const interrupt = createRequest(
    "client",
    "thread-follower-interrupt-turn",
    { conversationId: "conversation", mode: "user-stop", expectedTurnId: "turn" },
    { requestId: "interrupt", targetClientId: "owner", timeoutMs: 5_000 },
  );

  assert.deepEqual(initialize, {
    type: "request",
    requestId: "init",
    sourceClientId: "initializing-client",
    version: 0,
    method: "initialize",
    params: { clientType: "vscode" },
  });
  assert.equal(interrupt.version, 4);
  assert.equal(interrupt.targetClientId, "owner");
});
