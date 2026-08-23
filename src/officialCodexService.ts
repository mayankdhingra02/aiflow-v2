import * as path from "node:path";

import {
  OFFICIAL_EXTENSION_ID,
  assertSupportedExtensionVersion,
  boundedErrorMessage,
} from "./constants";
import {
  canonicalWorkspacePath,
  validateOfficialCodexRunRequest,
  type OfficialCodexRunRequest,
  type OfficialCodexRunResult,
} from "./officialCodexContracts";
import type { CancellationRequestResult } from "./officialCodexWorker";

export type OfficialCodexErrorCode =
  | "INVALID_REQUEST"
  | "WORKSPACE_INVALID"
  | "WORKSPACE_MISMATCH"
  | "EXTENSION_UNAVAILABLE"
  | "EXTENSION_VERSION"
  | "RUN_ACTIVE"
  | "EXECUTION_FAILED";

export class OfficialCodexError extends Error {
  constructor(
    public readonly code: OfficialCodexErrorCode,
    message: string,
  ) {
    super(boundedErrorMessage(message));
    this.name = "OfficialCodexError";
  }
}

export interface WorkspaceFolderDescriptor {
  scheme: string;
  path: string;
}

export interface WorkspaceResolver {
  getWorkspaceFolders(): Promise<WorkspaceFolderDescriptor[]>;
}

export interface OfficialExtensionDescriptor {
  version: unknown;
  isActive: boolean;
  activate(): Promise<void>;
}

export interface OfficialExtensionResolver {
  getOfficialExtension(id: string): Promise<OfficialExtensionDescriptor | null>;
}

export interface OfficialCodexRunExecutor {
  readonly isActive: boolean;
  run(request: OfficialCodexRunRequest): Promise<OfficialCodexRunResult>;
  cancel(): Promise<CancellationRequestResult>;
  dispose?(): void;
}

export function createWorkspaceAuthorizer(
  workspaceResolver: WorkspaceResolver,
): (requestWorkspacePath: string) => Promise<string> {
  return async (requestWorkspacePath: string): Promise<string> => {
    const openWorkspace = await requireOneCanonicalWorkspace(workspaceResolver);
    let requestWorkspace: string;
    try {
      requestWorkspace = await canonicalWorkspacePath(requestWorkspacePath);
    } catch {
      throw new OfficialCodexError("WORKSPACE_INVALID", "Request workspace is not a local directory");
    }
    if (path.normalize(openWorkspace) !== path.normalize(requestWorkspace)) {
      throw new OfficialCodexError(
        "WORKSPACE_MISMATCH",
        "Request workspace does not match the one open VS Code workspace",
      );
    }
    return requestWorkspace;
  };
}

export async function getOpenCanonicalWorkspace(
  workspaceResolver: WorkspaceResolver,
): Promise<string> {
  return requireOneCanonicalWorkspace(workspaceResolver);
}

export class OfficialCodexExecutionService {
  private readonly authorizeWorkspace: (workspacePath: string) => Promise<string>;

  constructor(
    public readonly worker: OfficialCodexRunExecutor,
    private readonly workspaceResolver: WorkspaceResolver,
    private readonly extensionResolver: OfficialExtensionResolver,
  ) {
    this.authorizeWorkspace = createWorkspaceAuthorizer(workspaceResolver);
  }

  async run(argument: unknown): Promise<OfficialCodexRunResult> {
    let request: OfficialCodexRunRequest;
    try {
      validateOfficialCodexRunRequest(argument);
      request = argument;
    } catch (error) {
      throw this.wrap(error, "INVALID_REQUEST");
    }

    try {
      const workspacePath = await this.authorizeWorkspace(request.workspacePath);
      await this.requireOfficialExtension();
      if (this.worker.isActive) {
        throw new OfficialCodexError("RUN_ACTIVE", "An official Codex run is already active");
      }
      return await this.worker.run({ ...request, workspacePath });
    } catch (error) {
      throw this.wrap(error, "EXECUTION_FAILED", request.prompt);
    }
  }

  async cancel(): Promise<CancellationRequestResult> {
    try {
      return await this.worker.cancel();
    } catch (error) {
      throw this.wrap(error, "EXECUTION_FAILED");
    }
  }

  dispose(): void {
    this.worker.dispose?.();
  }

  private async requireOfficialExtension(): Promise<void> {
    const extension = await this.extensionResolver.getOfficialExtension(OFFICIAL_EXTENSION_ID);
    if (!extension) {
      throw new OfficialCodexError(
        "EXTENSION_UNAVAILABLE",
        `${OFFICIAL_EXTENSION_ID} is not installed`,
      );
    }
    try {
      assertSupportedExtensionVersion(extension.version);
    } catch (error) {
      throw this.wrap(error, "EXTENSION_VERSION");
    }
    await extension.activate();
    if (!extension.isActive) {
      throw new OfficialCodexError(
        "EXTENSION_UNAVAILABLE",
        `${OFFICIAL_EXTENSION_ID} did not become active`,
      );
    }
  }

  private wrap(
    error: unknown,
    fallbackCode: OfficialCodexErrorCode,
    prompt?: string,
  ): OfficialCodexError {
    if (error instanceof OfficialCodexError) {
      return error;
    }
    const message = boundedErrorMessage(error);
    return new OfficialCodexError(
      fallbackCode,
      prompt && message.includes(prompt) ? "Official Codex operation failed" : message,
    );
  }
}

async function requireOneCanonicalWorkspace(workspaceResolver: WorkspaceResolver): Promise<string> {
  const folders = await workspaceResolver.getWorkspaceFolders();
  if (folders.length !== 1 || folders[0].scheme !== "file") {
    throw new OfficialCodexError(
      "WORKSPACE_INVALID",
      "Open exactly one local workspace folder before running Official Codex",
    );
  }
  try {
    return await canonicalWorkspacePath(folders[0].path);
  } catch {
    throw new OfficialCodexError("WORKSPACE_INVALID", "Open workspace is not a local directory");
  }
}
