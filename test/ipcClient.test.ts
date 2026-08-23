import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type * as net from "node:net";
import { test } from "node:test";

import { CodexIpcClient } from "../src/ipcClient";
import { FrameDecoder, encodeFrame, type IpcRequest } from "../src/protocol";

test("failed IPC initialization destroys and resets the socket before reconnecting", async () => {
  const sockets: FakeSocket[] = [];
  let connectionAttempt = 0;
  const client = new CodexIpcClient({
    socketPath: "/not-a-real-codex-socket",
    requestTimeoutMs: 100,
    createConnection: () => {
      connectionAttempt += 1;
      const attempt = connectionAttempt;
      const socket = new FakeSocket((request) => {
        queueMicrotask(() => {
          socket.emit(
            "data",
            encodeFrame({
              type: "response",
              requestId: request.requestId,
              resultType: "success",
              method: "initialize",
              handledByClientId: "owner",
              result: attempt === 1 ? {} : { clientId: "initialized-client" },
            }),
          );
        });
      });
      sockets.push(socket);
      queueMicrotask(() => socket.emit("connect"));
      return socket as unknown as net.Socket;
    },
  });

  await assert.rejects(client.connect(), /did not contain clientId/);
  assert.equal(sockets[0].destroyCalled, true);
  assert.equal(sockets[0].writable, true, "fake remains writable to exercise state reset");
  await assert.rejects(
    client.request("thread-owner-discovery", { conversationId: "conversation" }),
    /not connected/,
  );

  await client.connect();
  assert.equal(connectionAttempt, 2);
  client.dispose();
  assert.equal(sockets[1].destroyCalled, true);
});

class FakeSocket extends EventEmitter {
  writable = true;
  destroyCalled = false;
  private readonly decoder = new FrameDecoder();

  constructor(private readonly onRequest: (request: IpcRequest) => void) {
    super();
  }

  write(data: Uint8Array): boolean {
    const messages = this.decoder.push(Buffer.from(data));
    for (const message of messages) {
      this.onRequest(message as unknown as IpcRequest);
    }
    return true;
  }

  destroy(): this {
    this.destroyCalled = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }
}
