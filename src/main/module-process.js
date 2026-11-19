const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fork, spawn, spawnSync } = require('node:child_process');
const { createTaskError, serializeTaskError } = require('../shared/task-errors');

const liveProcesses = new Set();

function terminateTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); }
    catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', () => {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
      resolve();
    });
    killer.once('close', resolve);
  });
}

// The exit hook is a last resort for abrupt application shutdown. Normal
// shutdown awaits disposeModuleProcesses(), including descendant cleanup.
process.once('exit', () => {
  for (const { child, descendants } of liveProcesses) {
    for (const pid of [child.pid, ...descendants]) {
      if (!Number.isSafeInteger(pid) || pid <= 0) continue;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 2000 });
      } else {
        try { process.kill(-pid, 'SIGKILL'); }
        catch { try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ } }
      }
    }
  }
});

function cancelled() {
  return createTaskError('TASK_CANCELLED', '任务已取消', { name: 'AbortError' });
}

function processFailure(name, details) {
  return createTaskError('MODULE_PROCESS_EXITED', `${name}模块进程已停止，请重试`, { retryable: true, details });
}

class ModuleProcess extends EventEmitter {
  constructor({ modulePath, moduleName, options = {}, handlers = {}, cancelGraceMs = 8000,
    forkProcess = fork, workerPath = path.join(__dirname, 'module-worker.js') } = {}) {
    super();
    if (typeof modulePath !== 'string' || !path.isAbsolute(modulePath)) throw new Error('Module path must be absolute');
    Object.assign(this, { modulePath, moduleName: moduleName ?? path.basename(modulePath, '.js'),
      options, handlers, cancelGraceMs, forkProcess, workerPath });
    this.sequence = 0;
    this.disposed = false;
    this.worker = null;
  }

  async invoke(method, args = [], { signal, onProgress } = {}) {
    if (this.disposed) throw createTaskError('MODULE_DISPOSED', `${this.moduleName}模块已关闭`);
    if (signal?.aborted) throw cancelled();
    if (typeof method !== 'string' || !Array.isArray(args)) throw new TypeError('Invalid module request');
    while (this.worker?.terminating) await this.worker.closed;
    if (this.disposed) throw createTaskError('MODULE_DISPOSED', `${this.moduleName}模块已关闭`);
    if (signal?.aborted) throw cancelled();
    const state = this.worker ?? this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onProgress };
      entry.abort = () => {
        if (!state.pending.has(id) || entry.cancelTimer) return;
        this.send(state, { type: 'cancel', id });
        entry.cancelTimer = setTimeout(() => {
          void this.stop(state, createTaskError('MODULE_CANCEL_TIMEOUT', `${this.moduleName}模块未响应取消，请重试`, {
            retryable: true
          }));
        }, this.cancelGraceMs);
        entry.cancelTimer.unref?.();
      };
      state.pending.set(id, entry);
      state.child.ref();
      state.child.channel?.ref();
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.send(state, { type: 'invoke', id, method, args });
      if (signal?.aborted) entry.abort();
    });
  }

  start() {
    const child = this.forkProcess(this.workerPath, [], {
      windowsHide: true, detached: process.platform !== 'win32',
      // Node and Electron can embed different V8 versions; JSON IPC remains
      // compatible when a development Node process supervises Electron.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], serialization: 'json',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    let closed;
    const state = { owner: this, child, pending: new Map(), descendants: new Set(), terminating: false,
      closed: new Promise((resolve) => { closed = resolve; }), close: closed };
    this.worker = state;
    liveProcesses.add(state);
    child.on('message', (message) => { void this.receive(state, message); });
    child.on('error', (error) => {
      state.failure ??= error;
      if (!child.pid) void this.finish(state, null, null);
      else void this.stop(state, error);
    });
    child.once('disconnect', () => {
      if (!state.finishing) void this.stop(state, processFailure(this.moduleName, { reason: 'ipc-disconnected' }));
    });
    child.once('exit', () => { state.terminating = true; });
    child.once('close', (code, exitSignal) => { void this.finish(state, code, exitSignal); });
    child.unref();
    child.channel?.unref();
    this.send(state, { type: 'initialize', modulePath: this.modulePath, options: this.options });
    return state;
  }

  send(state, message) {
    if (state.finished || !state.child.connected) return;
    try {
      state.child.send(message, (error) => {
        if (error && !state.finished) void this.stop(state, error);
      });
    } catch (error) { void this.stop(state, error); }
  }

  async receive(state, message) {
    if (!message || state.finished) return;
    if (message.type === 'progress') {
      const entry = state.pending.get(message.id);
      if (entry && !entry.signal?.aborted) {
        try { entry.onProgress?.(message.value); }
        catch (error) { entry.failure = error; entry.abort(); }
      }
      return;
    }
    if (message.type === 'result' || message.type === 'error') {
      const entry = state.pending.get(message.id);
      if (!entry) return;
      this.removeEntry(state, message.id, entry);
      if (entry.signal?.aborted) entry.reject(cancelled());
      else if (entry.failure) entry.reject(entry.failure);
      else if (message.type === 'error') entry.reject(Object.assign(new Error(message.error.message), message.error));
      else entry.resolve(message.value);
      return;
    }
    if (message.type === 'main-call') {
      try {
        const handler = Object.hasOwn(this.handlers, message.method) && this.handlers[message.method];
        if (typeof handler !== 'function') throw createTaskError('MODULE_METHOD_UNAVAILABLE', '主进程服务不可用');
        const value = await handler(...message.args);
        this.send(state, { type: 'main-result', id: message.id, value });
      } catch (error) {
        this.send(state, { type: 'main-error', id: message.id, error: { ...serializeTaskError(error), name: error?.name } });
      }
      return;
    }
    if (message.type === 'event') {
      try { this.emit('event', message.name, message.value); }
      catch { /* A failed UI observer cannot crash the application's main loop. */ }
    } else if (message.type === 'child-started' && Number.isSafeInteger(message.pid)
      && message.pid > 0 && message.pid !== process.pid && message.pid !== state.child.pid) {
      state.descendants.add(message.pid);
    } else if (message.type === 'child-closed') state.descendants.delete(message.pid);
    else if (message.type === 'initialization-error') {
      void this.stop(state, Object.assign(new Error(message.error.message), message.error));
    }
  }

  removeEntry(state, id, entry) {
    state.pending.delete(id);
    clearTimeout(entry.cancelTimer);
    entry.signal?.removeEventListener('abort', entry.abort);
    if (!state.pending.size) {
      state.child.unref();
      state.child.channel?.unref();
    }
  }

  async stop(state, error) {
    if (state.finished) return state.closed;
    state.failure ??= error;
    if (!state.terminating) {
      state.terminating = true;
      state.child.ref();
      state.child.channel?.ref();
      await terminateTree(state.child.pid);
    }
    return state.closed;
  }

  async finish(state, code, exitSignal) {
    if (state.finishing) return state.closed;
    state.finishing = true;
    state.terminating = true;
    if (process.platform !== 'win32') await terminateTree(state.child.pid);
    await Promise.all([...state.descendants].map(terminateTree));
    state.finished = true;
    liveProcesses.delete(state);
    const error = state.failure ?? processFailure(this.moduleName, { exitCode: code, exitSignal });
    for (const [id, entry] of state.pending) {
      this.removeEntry(state, id, entry);
      entry.reject(entry.signal?.aborted ? cancelled() : entry.failure ?? error);
    }
    if (this.worker === state) this.worker = null;
    state.close();
    try { this.emit('stopped', error); } catch { /* Independent module observer. */ }
  }

  async dispose() {
    this.disposed = true;
    if (this.worker) await this.stop(this.worker, createTaskError('MODULE_DISPOSED', `${this.moduleName}模块已关闭`));
  }
}

async function disposeModuleProcesses() {
  await Promise.allSettled([...liveProcesses].map((state) => state.owner.dispose()));
}

module.exports = { ModuleProcess, disposeModuleProcesses };
