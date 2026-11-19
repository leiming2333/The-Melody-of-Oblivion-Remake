const { createTaskError, serializeTaskError } = require('../shared/task-errors');

const active = new Map();
const mainCalls = new Map();
let initialization;
let sequence = 0;
let disconnected = false;

function send(message, callback) {
  if (!process.connected) { callback?.(); return; }
  try { process.send(message, callback ?? (() => {})); }
  catch { callback?.(); }
}

function serialize(error) {
  return { ...serializeTaskError(error), name: error?.name,
    ...(Number.isInteger(error?.exitCode) ? { exitCode: error.exitCode } : {}) };
}

function callMain(method, args = []) {
  if (disconnected) return Promise.reject(createTaskError('MODULE_DISPOSED', '主进程已关闭'));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    mainCalls.set(id, { resolve, reject });
    send({ type: 'main-call', id, method, args });
  });
}

function reportChild(child) {
  if (child?.pid) {
    send({ type: 'child-started', pid: child.pid });
    child.once('close', () => send({ type: 'child-closed', pid: child.pid }));
  }
  return child;
}

function progress(entry, value) {
  if (entry.controller.signal.aborted) return;
  const phaseChanged = value?.phase !== entry.phase;
  entry.phase = value?.phase;
  entry.latest = value;
  if (phaseChanged || value?.cancellable === false || value?.phase === 'complete' || Date.now() - entry.sentAt >= 100) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.sentAt = Date.now();
    send({ type: 'progress', id: entry.id, value });
    entry.latest = undefined;
  } else if (!entry.timer) {
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entry.latest !== undefined && !entry.controller.signal.aborted) {
        send({ type: 'progress', id: entry.id, value: entry.latest });
        entry.latest = undefined;
        entry.sentAt = Date.now();
      }
    }, 100);
    entry.timer.unref?.();
  }
}

async function invoke(message) {
  const entry = { id: message.id, controller: new AbortController(), sentAt: 0 };
  active.set(message.id, entry);
  try {
    const module = await initialization;
    if (entry.controller.signal.aborted) throw createTaskError('TASK_CANCELLED', '任务已取消', { name: 'AbortError' });
    if (!module || !/^[A-Za-z][\w:-]{0,100}$/.test(message.method)
      || ['constructor', '__proto__', 'prototype'].includes(message.method)
      || typeof module[message.method] !== 'function') {
      throw createTaskError('MODULE_METHOD_UNAVAILABLE', '模块功能不可用');
    }
    const value = await module[message.method](...message.args, {
      signal: entry.controller.signal, onProgress: (value) => progress(entry, value)
    });
    if (entry.latest !== undefined && !entry.controller.signal.aborted) {
      send({ type: 'progress', id: entry.id, value: entry.latest });
    }
    send({ type: 'result', id: message.id, value });
  } catch (error) {
    send({ type: 'error', id: message.id, error: serialize(error) });
  } finally {
    clearTimeout(entry.timer);
    active.delete(message.id);
    if (disconnected && !active.size) process.exit(0);
  }
}

process.on('message', (message) => {
  if (!message) return;
  if (message.type === 'initialize' && !initialization) {
    initialization = Promise.resolve().then(() => {
      const { createModule } = require(message.modulePath);
      if (typeof createModule !== 'function') throw new Error('Module factory is missing');
      return createModule({ options: message.options, callMain, reportChild,
        emit: (name, value) => send({ type: 'event', name, value }) });
    });
    initialization.catch((error) => send({ type: 'initialization-error', error: serialize(error) }));
  } else if (message.type === 'invoke') {
    void invoke(message);
  } else if (message.type === 'cancel') active.get(message.id)?.controller.abort();
  else if (message.type === 'main-result' || message.type === 'main-error') {
    const entry = mainCalls.get(message.id);
    if (!entry) return;
    mainCalls.delete(message.id);
    if (message.type === 'main-error') entry.reject(Object.assign(new Error(message.error.message), message.error));
    else entry.resolve(message.value);
  }
});

process.on('disconnect', () => {
  disconnected = true;
  for (const entry of active.values()) entry.controller.abort();
  for (const entry of mainCalls.values()) entry.reject(createTaskError('MODULE_DISPOSED', '主进程已关闭'));
  mainCalls.clear();
  if (!active.size) process.exit(0);
  const deadline = setTimeout(() => process.exit(0), 8000);
  deadline.unref?.();
});
