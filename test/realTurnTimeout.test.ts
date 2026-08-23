import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_REAL_TURN_TIMEOUT_MINUTES,
  MAX_REAL_TURN_TIMEOUT_MINUTES,
  MILLISECONDS_PER_MINUTE,
  MIN_REAL_TURN_TIMEOUT_MINUTES,
  OfficialCodexConfigurationError,
  REAL_TURN_TIMEOUT_MS,
  resolveRealTurnTimeoutMs,
} from "../src/constants";
import { createAppLifetimeOfficialCodexWorker } from "../src/appLifetimeWorker";
import type { OfficialCodexWorkerOptions } from "../src/officialCodexWorker";

test("real turn timeout defaults to exactly 60 minutes", () => {
  assert.equal(DEFAULT_REAL_TURN_TIMEOUT_MINUTES, 60);
  assert.equal(resolveRealTurnTimeoutMs(undefined), 60 * MILLISECONDS_PER_MINUTE);
  assert.equal(REAL_TURN_TIMEOUT_MS, 60 * MILLISECONDS_PER_MINUTE);
});

test("real turn timeout accepts its inclusive minimum, ordinary value, and maximum", () => {
  assert.equal(
    resolveRealTurnTimeoutMs(MIN_REAL_TURN_TIMEOUT_MINUTES),
    3 * MILLISECONDS_PER_MINUTE,
  );
  assert.equal(resolveRealTurnTimeoutMs(30), 30 * MILLISECONDS_PER_MINUTE);
  assert.equal(
    resolveRealTurnTimeoutMs(MAX_REAL_TURN_TIMEOUT_MINUTES),
    240 * MILLISECONDS_PER_MINUTE,
  );
});

test("real turn timeout rejects invalid configured values with a bounded typed error", () => {
  for (const value of [2, 241, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolveRealTurnTimeoutMs(value),
      (error: unknown) =>
        error instanceof OfficialCodexConfigurationError &&
        error.code === "INVALID_CONFIGURATION" &&
        error.message.length <= 400,
    );
  }
});

test("app-lifetime worker construction passes the resolved timeout to the shared worker", () => {
  const captured: { options: OfficialCodexWorkerOptions | null } = { options: null };
  createAppLifetimeOfficialCodexWorker(
    {
      sessionsRoot: "/sessions",
      tempRoot: "/temp",
      authorizeWorkspace: async (workspacePath) => workspacePath,
      invokeBootstrap: async () => {},
      realTurnTimeoutMinutes: 30,
    },
    (options) => {
      captured.options = options;
      return {} as ReturnType<typeof createAppLifetimeOfficialCodexWorker>;
    },
  );
  assert.equal(captured.options?.realTurnTimeoutMs, 30 * MILLISECONDS_PER_MINUTE);
});
