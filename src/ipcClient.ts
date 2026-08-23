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
  createConnection?: (socketPath: string) => net.Socket;
}

export class CodexIpcClient {
  private decoder = new FrameDecoder();
  private readonly correlator = new RequestCorrelator();
  private socket: net.Socket | null = null;
  private clientId = INITIALIZING_CLIENT_ID;
  private disposed = false;

  constructor(private readonly options: IpcClientOptions) {}

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error("IPC client is disposed");
    }
    if (this.socket?.writable && this.clientId !== INITIALIZING_CLIENT_ID) {
      return;
    }

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      let candidate: net.Socket;
      try {
        candidate = (this.options.createConnection ?? net.createConnection)(
          this.options.socketPath,
        );
      } catch (error) {
        reject(
          new Error(`Unable to connect to Codex IPC socket: ${boundedErrorMessage(error)}`),
        );
        return;
      }
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new Error("Timed out connecting to Codex IPC socket"));
      }, this.options.connectTimeoutMs ?? IPC_CONNECT_TIMEOUT_MS);

      const onConnect = (): void => {
        clearTimeout(timer);
        candidate.removeListener("error", onError);
        resolve(candidate);
      };
      const onError = (error: Error): void => {
        clearTimeout(timer);
        candidate.removeListener("connect", onConnect);
        candidate.destroy();
        reject(new Error(`Unable to connect to Codex IPC socket: ${boundedErrorMessage(error)}`));
      };
      candidate.once("connect", onConnect);
      candidate.once("error", onError);
    });

    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      if (this.socket === socket) {
        this.handleData(chunk);
      }
    });
    socket.on("error", (error) => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.clientId = INITIALIZING_CLIENT_ID;
      this.decoder = new FrameDecoder();
      this.correlator.rejectAll(
        new Error(`Codex IPC socket error: ${boundedErrorMessage(error)}`),
      );
    });
    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.clientId = INITIALIZING_CLIENT_ID;
      this.decoder = new FrameDecoder();
      this.correlator.rejectAll(new Error("Codex IPC socket closed"));
    });

    try {
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
    } catch (error) {
      if (this.socket === socket) {
        this.socket = null;
      }
      this.clientId = INITIALIZING_CLIENT_ID;
      this.decoder = new FrameDecoder();
      socket.destroy();
      throw error;
    }
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
    this.clientId = INITIALIZING_CLIENT_ID;
    this.decoder = new FrameDecoder();
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
