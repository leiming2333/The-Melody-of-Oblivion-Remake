const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { ModuleProcess } = require('../src/main/module-process');
const { getInstalledElectronPath } = require('./helpers/electron-runtime');
const electronRuntime = getInstalledElectronPath();

const source = `
  exports.createModule = ({ options, callMain, emit }) => {
    let count = 0;
    return {
      increment: () => ({ count: ++count, pid: process.pid, initial: options.initial }),
      fail: () => { throw Object.assign(new Error('Module operation failed'), {
        code: 'FIXTURE_FAILURE', phase: 'fixture', retryable: true, details: { file: '/tmp/fixture' }
      }); },
      crash: () => process.exit(23),
      busy: (releasePath, context) => {
        context.onProgress({ phase: 'busy', pid: process.pid });
        const until = Date.now() + 10_000;
        while (!require('node:fs').existsSync(releasePath) && Date.now() < until) { /* Independent event loop. */ }
        return 'done';
      },
      wait: async (name, context) => {
        context.onProgress({ phase: 'waiting', name });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 60_000);
          context.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          }, { once: true });
        });
        return name;
      },
      ignoreCancel: (context) => {
        context.onProgress({ phase: 'ignoring-cancellation' });
        return new Promise(() => {});
      },
      callback: async (value) => {
        const result = await callMain('double', [value]);
        emit('updated', result);
        return result;
      },
      progress: (context) => {
        for (let value = 0; value < 10_000; value++) context.onProgress({ phase: 'download', value });
        context.onProgress({ phase: 'complete', value: 10_000 });
        return 'done';
      }
    };
  };
`;

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-module-process-'));
  const modulePath = path.join(directory, 'module.cjs');
  await fs.writeFile(modulePath, options.source ?? source);
  const module = new ModuleProcess({ modulePath, options: { initial: 'ready' }, ...options });
  t.after(async () => {
    await module.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return module;
}

test('modules preserve their own state and initialize only on first invocation', async (t) => {
  const module = await fixture(t);
  assert.equal(module.worker, null);
  const first = await module.invoke('increment');
  const second = await module.invoke('increment');
  assert.equal(first.initial, 'ready');
  assert.equal(first.count, 1);
  assert.equal(second.count, 2);
  assert.equal(first.pid, second.pid);
  assert.notEqual(first.pid, process.pid);
});

test('a busy module cannot block the main loop or a different module', async (t) => {
  const busy = await fixture(t), other = await fixture(t);
  await other.invoke('increment');
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let completed = false;
  const releasePath = path.join(path.dirname(busy.modulePath), 'release');
  const pending = busy.invoke('busy', [releasePath], { onProgress: () => entered() }).then(() => { completed = true; });
  await started;
  assert.equal((await other.invoke('increment')).count, 2);
  assert.equal(completed, false);
  await fs.writeFile(releasePath, 'release');
  await pending;
});

test('cancellation belongs to one request and leaves the other request and module alive', async (t) => {
  const module = await fixture(t);
  const first = new AbortController(), second = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let secondStarted;
  const secondReady = new Promise((resolve) => { secondStarted = resolve; });
  const one = module.invoke('wait', ['one'], { signal: first.signal, onProgress: () => entered() });
  const oneCancelled = assert.rejects(one, { code: 'TASK_CANCELLED' });
  const two = module.invoke('wait', ['two'], { signal: second.signal, onProgress: () => secondStarted() });
  const twoCancelled = assert.rejects(two, { code: 'TASK_CANCELLED' });
  await Promise.all([started, secondReady]);
  first.abort();
  await oneCancelled;
  assert.equal(second.signal.aborted, false);
  assert.equal((await module.invoke('increment')).count, 1);
  second.abort();
  await twoCancelled;
  assert.equal((await module.invoke('increment')).count, 2);
});

test('structured operation failures do not discard healthy module state', async (t) => {
  const module = await fixture(t);
  await module.invoke('increment');
  await assert.rejects(module.invoke('fail'), (error) => {
    assert.equal(error.code, 'FIXTURE_FAILURE');
    assert.equal(error.phase, 'fixture');
    assert.equal(error.retryable, true);
    assert.equal(error.details.file, '/tmp/fixture');
    return true;
  });
  assert.equal((await module.invoke('increment')).count, 2);
});

test('crashing a module rejects all its requests and the next invocation starts a fresh process', async (t) => {
  const module = await fixture(t);
  const before = await module.invoke('increment');
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = module.invoke('wait', ['pending'], { onProgress: () => entered() });
  const pendingRejected = assert.rejects(pending, (error) => error.code === 'MODULE_PROCESS_EXITED' && error.retryable);
  await started;
  await assert.rejects(module.invoke('crash'), { code: 'MODULE_PROCESS_EXITED' });
  await pendingRejected;
  const after = await module.invoke('increment');
  assert.equal(after.count, 1);
  assert.notEqual(before.pid, after.pid);
});

test('a module ignoring cancellation is killed and can be retried', { timeout: 30000 }, async (t) => {
  const module = await fixture(t, { cancelGraceMs: 20 });
  const before = await module.invoke('increment');
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const pending = module.invoke('ignoreCancel', [], { signal: controller.signal, onProgress: () => entered() });
  const rejected = assert.rejects(pending, { code: 'TASK_CANCELLED' });
  await started;
  controller.abort();
  await rejected;
  const after = await module.invoke('increment');
  assert.equal(after.count, 1);
  assert.notEqual(before.pid, after.pid);
});

test('worker callbacks use main handlers and events without serializing Electron services', async (t) => {
  const module = await fixture(t, { handlers: { double: async (value) => value * 2 } });
  const event = once(module, 'event');
  assert.equal(await module.invoke('callback', [21]), 42);
  assert.deepEqual(await event, ['updated', 42]);
});

test('progress is coalesced while stage changes and final completion remain visible', async (t) => {
  const module = await fixture(t);
  const progress = [];
  assert.equal(await module.invoke('progress', [], { onProgress: value => progress.push(value) }), 'done');
  assert.ok(progress.length < 100, `received ${progress.length} updates`);
  assert.equal(progress[0].phase, 'download');
  assert.equal(progress.at(-1).phase, 'complete');
  assert.equal(progress.at(-1).value, 10_000);
});

test('already cancelled requests do not start a process and disposed modules cannot restart', async (t) => {
  const module = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(module.invoke('increment', [], { signal: controller.signal }), { code: 'TASK_CANCELLED' });
  assert.equal(module.worker, null);
  await module.dispose();
  await assert.rejects(module.invoke('increment'), { code: 'MODULE_DISPOSED' });
});

test('initialization failures preserve their error and can be retried after repairing the module', async (t) => {
  const module = await fixture(t, { source: `exports.createModule = () => { throw Object.assign(new Error('broken module'), { code: 'BROKEN_MODULE' }); };` });
  await assert.rejects(module.invoke('increment'), { code: 'BROKEN_MODULE' });
  await fs.writeFile(module.modulePath, source);
  assert.equal((await module.invoke('increment')).count, 1);
});

test('an idle persistent module does not prevent its parent process from exiting', async (t) => {
  const module = await fixture(t);
  const script = `
    const { ModuleProcess } = require(${JSON.stringify(require.resolve('../src/main/module-process'))});
    new ModuleProcess({ modulePath: process.argv[1] }).invoke('increment').then(() => console.log('DONE'));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', script, module.modulePath], {
    timeout: 30000, windowsHide: true
  });
  assert.match(stdout, /DONE/);
});

test('the persistent worker runs under the installed Electron runtime', {
  skip: electronRuntime ? false : 'Electron runtime is not installed; tests never download it'
}, async (t) => {
  const module = await fixture(t, { forkProcess: (filename, args, options) => fork(filename, args, {
    ...options, execPath: electronRuntime
  }) });
  assert.equal((await module.invoke('increment')).count, 1);
});
