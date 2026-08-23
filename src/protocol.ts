import { randomUUID } from "node:crypto";

import { ipcVersionFor, type ProbeIpcMethod } from "./constants";

export const MAX_IPC_FRAME_BYTES = 8 * 1024 * 1024;
export const INITIALIZING_CLIENT_ID = "initializing-client";

export interface IpcRequest {
  type: "request";
  requestId: string;
  sourceClientId: string;
  version: number;
  method: ProbeIpcMethod;
  params: unknown;
  targetClientId?: string;
  timeoutMs?: number;
}

export interface IpcSuccessResponse {
  type: "response";
  requestId: string;
  resultType: "success";
  method: string;
  handledByClientId: string;
  result: unknown;
}

export interface IpcErrorResponse {
  type: "response";
  requestId: string;
  resultType: "error";
  error: string;
}

export type IpcResponse = IpcSuccessResponse | IpcErrorResponse;

export interface ClientDiscoveryRequest {
  type: "client-discovery-request";
  requestId: string;
  request: IpcRequest;
}

export interface ClientDiscoveryResponse {
  type: "client-discovery-response";
  requestId: string;
  response: {
    canHandle: boolean;
  };
}

export type IpcMessage =
  | IpcResponse
  | ClientDiscoveryRequest
  | ClientDiscoveryResponse
  | Record<string, unknown>;

export function createRequest(
  sourceClientId: string,
  method: ProbeIpcMethod,
  params: unknown,
  options: { targetClientId?: string; timeoutMs?: number; requestId?: string } = {},
): IpcRequest {
  return {
    type: "request",
    requestId: options.requestId ?? randomUUID(),
    sourceClientId,
    version: ipcVersionFor(method),
    method,
    params,
    ...(options.targetClientId === undefined
      ? {}
      : { targetClientId: options.targetClientId }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

export function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.byteLength > MAX_IPC_FRAME_BYTES) {
    throw new Error(`IPC frame exceeds ${MAX_IPC_FRAME_BYTES} bytes`);
  }

  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32LE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Buffer): IpcMessage[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    this.buffered = Buffer.concat([this.buffered, chunk]);
    const messages: IpcMessage[] = [];

    while (this.buffered.byteLength >= 4) {
      const payloadLength = this.buffered.readUInt32LE(0);
      if (payloadLength === 0) {
        throw new Error("IPC frame declares a zero-length payload");
      }
      if (payloadLength > MAX_IPC_FRAME_BYTES) {
        throw new Error(`IPC frame declares ${payloadLength} bytes`);
      }
      if (this.buffered.byteLength < payloadLength + 4) {
        break;
      }

      const payload = this.buffered.subarray(4, payloadLength + 4).toString("utf8");
      this.buffered = this.buffered.subarray(payloadLength + 4);
      try {
        messages.push(JSON.parse(payload) as IpcMessage);
      } catch {
        throw new Error("Invalid UTF-8 JSON in IPC frame");
      }
    }

    if (this.buffered.byteLength > MAX_IPC_FRAME_BYTES + 4) {
      throw new Error("IPC receive buffer exceeded the maximum frame size");
    }
    return messages;
  }
}

interface PendingResponse {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (response: IpcResponse) => void;
  reject: (error: Error) => void;
}

export class RequestCorrelator {
  private readonly pending = new Map<string, PendingResponse>();

  wait(requestId: string, method: string, timeoutMs: number): Promise<IpcResponse> {
    if (this.pending.has(requestId)) {
      throw new Error(`Duplicate IPC request ID: ${requestId}`);
    }

    return new Promise<IpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`IPC request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(requestId, { method, timer, resolve, reject });
    });
  }

  resolve(response: IpcResponse): boolean {
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      return false;
    }
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
    return true;
  }

  reject(requestId: string, error: Error): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
    return true;
  }

  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
