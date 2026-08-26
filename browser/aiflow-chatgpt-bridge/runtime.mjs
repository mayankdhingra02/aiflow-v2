export function createBrowserRuntimeTimers(target = globalThis) {
  return {
    setTimeout: (...arguments_) => target.setTimeout(...arguments_),
    clearTimeout: (...arguments_) => target.clearTimeout(...arguments_),
    setInterval: (...arguments_) => target.setInterval(...arguments_),
    clearInterval: (...arguments_) => target.clearInterval(...arguments_),
  };
}
