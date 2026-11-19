const path = require('node:path');
const { fork, spawn, spawnSync } = require('node:child_process');
const { createTaskError } = require('../../shared/task-errors');

const liveInstallations = new Set();

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid;
}

function terminateTree(pid) {
  if (!validPid(pid)) return Promise.resolve();
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

function terminateTreeSync(pid) {
  if (!validPid(pid)) return;
  if (process.platform === 'win32') {
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', timeout: 2000
      });
      if (!result.error && result.status === 0) return;
    } catch { /* Fall back to stopping the known process. */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); return; } catch { /* Try the process itself. */ }
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
}

// Normal shutdown awaits cancellation below. Synchronous cleanup is the final
// fallback when an unexpected exit leaves no time to await worker shutdown.
process.once('exit', () => {
  for (const state of liveInstallations) {
    terminateTreeSync(state.child.pid);
    for (const pid of state.descendants) terminateTreeSync(pid);
  }
});

// Installation and metadata browsing each own an independent event loop and
// heap, so a busy installer cannot block browsing or the main process.
class LoaderInstallProcess {
  constructor(options = {}) {
    Object.assign(this, options);
    this.installations = new Set();
    this.disposed = false;
  }

  installLoader(request, onProgress = () => {}, { signal } = {}) {
    if (this.disposed) return Promise.reject(createTaskError('INSTALLER_DISPOSED', '加载器安装模块已关闭'));
    if (signal?.aborted) return Promise.reject(createTaskError('TASK_CANCELLED', '下载已取消'));
    const controller = new AbortController();
    signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return new Promise((resolve, reject) => {
      const child = (this.forkProcess ?? fork)(this.workerPath ?? path.join(__dirname, 'loader-install-worker.js'), [], {
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
      let outcome;
      let failure;
      let settled = false;
      let cancelTimer;
      const descendants = new Set();
      let close;
      const state = { child, descendants, controller, owner: this,
        closed: new Promise((resolveClosed) => { close = resolveClosed; }) };
      this.installations.add(state);
      liveInstallations.add(state);
      const release = () => {
        this.installations.delete(state);
        liveInstallations.delete(state);
        close();
      };
      const cleanup = () => {
        settled = true;
        clearTimeout(cancelTimer);
        signal?.removeEventListener('abort', cancel);
      };
      const cancel = () => {
        if (settled || cancelTimer) return;
        if (child.connected) child.send({ type: 'cancel' }, () => {});
        // Give downloads and Java time to close their handles before escalating.
        // Kill the entire tree, so an orphaned Java installer cannot keep writing.
        cancelTimer = setTimeout(() => {
          if (settled) return;
          void terminateTree(child.pid);
        }, this.cancelGraceMs ?? 8000);
        cancelTimer.unref?.();
      };
      child.on('error', (error) => {
        failure = error;
        if (!child.pid && !settled) { cleanup(); release(); reject(error); }
      });
      child.on('message', (message) => {
        if (settled || !message) return;
        if (message.type === 'progress' && !signal?.aborted) {
          try { onProgress(message.value); }
          catch (error) { failure = error; cancel(); }
        } else if (message.type === 'result') outcome = message.value;
        else if (message.type === 'error') {
          failure = Object.assign(new Error(message.value.message), message.value);
        } else if (message.type === 'child-started' && Number.isSafeInteger(message.pid)
            && message.pid > 0 && message.pid !== process.pid && message.pid !== child.pid) {
          descendants.add(message.pid);
        } else if (message.type === 'child-closed') {
          descendants.delete(message.pid);
        }
      });
      child.once('close', async (code, exitSignal) => {
        if (settled) return;
        cleanup();
        // A crashed worker can leave Java running. Retain task ownership until
        // its reported descendants are stopped, before any new writer starts.
        if (process.platform !== 'win32') await terminateTree(child.pid);
        await Promise.all([...descendants].map(terminateTree));
        release();
        if (signal?.aborted) { reject(createTaskError('TASK_CANCELLED', '下载已取消')); return; }
        if (failure) { reject(failure); return; }
        if (code === 0 && outcome) { resolve(outcome); return; }
        reject(createTaskError('INSTALLER_PROCESS_EXITED', '加载器安装进程意外退出，可以重试安装', {
          phase: 'installing-loader', retryable: true, details: { exitCode: code, exitSignal }
        }));
      });
      signal?.addEventListener('abort', cancel, { once: true });
      child.send({ type: 'install', request, options: {
        gameDirectory: this.gameDirectory, concurrency: this.concurrency,
        segmentConcurrency: this.segmentConcurrency, downloadSource: this.downloadSource, javaPath: this.javaPath
      } }, (error) => {
        if (error && !settled) { failure = error; cancel(); }
      });
      if (signal?.aborted) cancel();
    });
  }

  async dispose() {
    this.disposed = true;
    const installations = [...this.installations];
    for (const state of installations) state.controller.abort();
    await Promise.all(installations.map((state) => state.closed));
  }
}

async function disposeLoaderInstallProcesses() {
  await Promise.allSettled([...new Set([...liveInstallations].map((state) => state.owner))]
    .map((installer) => installer.dispose()));
}

module.exports = { LoaderInstallProcess, disposeLoaderInstallProcesses };
