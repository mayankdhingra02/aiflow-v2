import { resolveRealTurnTimeoutMs } from "./constants";
import { OfficialCodexWorker, type OfficialCodexWorkerOptions } from "./officialCodexWorker";

export interface AppLifetimeOfficialCodexWorkerOptions
  extends Omit<OfficialCodexWorkerOptions, "realTurnTimeoutMs"> {
  realTurnTimeoutMinutes: unknown;
}

export type OfficialCodexWorkerFactory = (
  options: OfficialCodexWorkerOptions,
) => OfficialCodexWorker;

export function createAppLifetimeOfficialCodexWorker(
  options: AppLifetimeOfficialCodexWorkerOptions,
  createWorker: OfficialCodexWorkerFactory = (workerOptions) => new OfficialCodexWorker(workerOptions),
): OfficialCodexWorker {
  const { realTurnTimeoutMinutes, ...workerOptions } = options;
  return createWorker({
    ...workerOptions,
    realTurnTimeoutMs: resolveRealTurnTimeoutMs(realTurnTimeoutMinutes),
  });
}
