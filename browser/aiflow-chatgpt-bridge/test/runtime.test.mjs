import assert from "node:assert/strict";
import { test } from "node:test";
import { createBrowserRuntimeTimers } from "../runtime.mjs";

test("production timer adapter preserves a receiver-sensitive global runtime", () => {
  const calls = [];
  const runtime = {
    marker: "runtime",
    setTimeout(callback, delay) { assert.equal(this, runtime); calls.push(["timeout", callback, delay]); return 1; },
    clearTimeout(id) { assert.equal(this, runtime); calls.push(["clearTimeout", id]); },
    setInterval(callback, delay) { assert.equal(this, runtime); calls.push(["interval", callback, delay]); return 2; },
    clearInterval(id) { assert.equal(this, runtime); calls.push(["clearInterval", id]); },
  };
  assert.throws(() => runtime.setTimeout.call(undefined, () => {}, 1));
  const timers = createBrowserRuntimeTimers(runtime);
  assert.equal(timers.setTimeout(() => {}, 10), 1);
  timers.clearTimeout(1);
  assert.equal(timers.setInterval(() => {}, 20), 2);
  timers.clearInterval(2);
  assert.deepEqual(calls.map(([name]) => name), ["timeout", "clearTimeout", "interval", "clearInterval"]);
});
