(function exposeUiModules(root) {
  function createModuleController({ create, onError = () => {} } = {}) {
    let instance;
    let state = 'idle';
    let lastError;
    let lastInvocation;
    const requests = new Map();
    const report = (error) => {
      state = 'error';
      if (lastError?.message !== error.message) {
        try { onError(error); } catch { /* Notification failures belong to this feature too. */ }
      }
      lastError = error;
    };
    function get() {
      if (!instance) instance = create();
      state = 'ready';
      return instance;
    }
    function invoke(method, args = []) {
      lastInvocation = [method, args];
      try {
        const result = get()[method](...args);
        if (result?.then) return result.catch((error) => { report(error); throw error; });
        return result;
      } catch (error) {
        report(error);
        return undefined;
      }
    }
    async function invokeAsync(method, args = []) {
      lastInvocation = [method, args];
      try { return await get()[method](...args); }
      catch (error) { report(error); throw error; }
    }
    function beginRequest(key) {
      requests.get(key)?.abort();
      const controller = new AbortController();
      requests.set(key, controller);
      return { signal: controller.signal,
        current: () => requests.get(key) === controller && !controller.signal.aborted,
        finish: () => { if (requests.get(key) === controller) requests.delete(key); } };
    }
    return { invoke, invokeAsync, get,
      get state() { return state; },
      get error() { return lastError; },
      retry() { instance = undefined; lastError = undefined; state = 'idle';
        return lastInvocation ? invoke(...lastInvocation) : undefined; },
      beginRequest,
      cancel(key) { requests.get(key)?.abort(); requests.delete(key); },
      dispose() { for (const request of requests.values()) request.abort(); requests.clear(); instance = undefined; state = 'idle'; }
    };
  }
  const exported = { createModuleController };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else Object.assign(root.launcherUiModules ??= {}, exported);
})(globalThis);
