import * as net from "node:net";

import {
  INITIALIZING_CLIENT_ID,
  FrameDecoder,
  RequestCorrelator,
  createRequest,
  encodeFrame,
  type ClientDiscoveryRequest,
  type ClientDiscoveryResponse,
  type IpcMessage,
  type IpcResponse,
  type IpcSuccessResponse,
} from "./protocol";
import {
  IPC_CONNECT_TIMEOUT_MS,
  IPC_REQUEST_TIMEOUT_MS,
  boundedErrorMessage,
  type ProbeIpcMethod,
} from "./constants";

export interface IpcClientOptions {
  socketPath: string;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
}

export class CodexIpcClient {
  private readonly decoder = new FrameDecoder();
  private readonly correlator = new RequestCorrelator();
  private socket: net.Socket | null = null;
  private clientId = INITIALIZING_CLIENT_ID;
  private disposed = false;

  constructor(private readonly options: IpcClientOptions) {}

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error("IPC client is disposed");
    }
    if (this.socket?.writable) {
      return;
    }

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection(this.options.socketPath);
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new Error("Timed out connecting to Codex IPC socket"));
      }, this.options.connectTimeoutMs ?? IPC_CONNECT_TIMEOUT_MS);

      candidate.once("connect", () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Unable to connect to Codex IPC socket: ${boundedErrorMessage(error)}`));
      });
    });

    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("error", (error) => {
      this.correlator.rejectAll(
        new Error(`Codex IPC socket error: ${boundedErrorMessage(error)}`),
      );
    });
    socket.on("close", () => {
      this.socket = null;
      this.correlator.rejectAll(new Error("Codex IPC socket closed"));
    });

    const initialized = await this.request(
      "initialize",
      { clientType: "vscode" },
      { sourceClientId: INITIALIZING_CLIENT_ID },
    );
    const result = asRecord(initialized.result);
    if (typeof result.clientId !== "string" || result.clientId.length === 0) {
      throw new Error("Codex IPC initialize response did not contain clientId");
    }
    this.clientId = result.clientId;
  }

  async request(
    method: ProbeIpcMethod,
    params: unknown,
    options: {
      targetClientId?: string;
      timeoutMs?: number;
      sourceClientId?: string;
    } = {},
  ): Promise<IpcSuccessResponse> {
    const socket = this.socket;
    if (!socket?.writable) {
      throw new Error("Codex IPC socket is not connected");
    }
    if (this.clientId === INITIALIZING_CLIENT_ID && method !== "initialize") {
      throw new Error("Codex IPC client is not initialized");
    }

    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs ?? IPC_REQUEST_TIMEOUT_MS;
    const request = createRequest(
      options.sourceClientId ?? this.clientId,
      method,
      params,
      {
        targetClientId: options.targetClientId,
        timeoutMs,
      },
    );
    const responsePromise = this.correlator.wait(request.requestId, method, timeoutMs);

    try {
      socket.write(encodeFrame(request));
    } catch (error) {
      this.correlator.reject(
        request.requestId,
        new Error(`Unable to write Codex IPC request: ${boundedErrorMessage(error)}`),
      );
    }

    const response = await responsePromise;
    if (response.resultType === "error") {
      throw new Error(`Codex IPC ${method} failed: ${boundedErrorMessage(response.error)}`);
    }
    if (response.method !== method) {
      throw new Error(`Codex IPC response method mismatch for ${method}`);
    }
    return response;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.correlator.rejectAll(new Error("Codex IPC client disposed"));
    this.socket?.destroy();
    this.socket = null;
  }

  private handleData(chunk: Buffer): void {
    let messages: IpcMessage[];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.correlator.rejectAll(
        new Error(`Unable to decode Codex IPC data: ${boundedErrorMessage(error)}`),
      );
      this.socket?.destroy();
      return;
    }

    for (const message of messages) {
      if (isIpcResponse(message)) {
        this.correlator.resolve(message);
      } else if (isClientDiscoveryRequest(message)) {
        this.sendCannotHandle(message);
      }
    }
  }

  private sendCannotHandle(message: ClientDiscoveryRequest): void {
    const response: ClientDiscoveryResponse = {
      type: "client-discovery-response",
      requestId: message.requestId,
      response: { canHandle: false },
    };
    this.socket?.write(encodeFrame(response));
  }
}

function isIpcResponse(message: IpcMessage): message is IpcResponse {
  const candidate = message as Partial<IpcResponse>;
  return (
    candidate.type === "response" &&
    typeof candidate.requestId === "string" &&
    (candidate.resultType === "success" || candidate.resultType === "error")
  );
}

function isClientDiscoveryRequest(message: IpcMessage): message is ClientDiscoveryRequest {
  const candidate = message as Partial<ClientDiscoveryRequest>;
  return (
    candidate.type === "client-discovery-request" &&
    typeof candidate.requestId === "string" &&
    typeof candidate.request === "object" &&
    candidate.request !== null
  );
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex IPC response had an unexpected shape");
  }
  return value as Record<string, unknown>;
}
