const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { LoaderInstallProcess, disposeLoaderInstallProcesses } = require('../src/main/minecraft/loader-install-process');

async function fixture(t, source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-loader-process-'));
  const workerPath = path.join(root, 'worker.cjs');
  await fs.writeFile(workerPath, source);
  const installer = new LoaderInstallProcess({ gameDirectory: root, workerPath });
  t.after(async () => {
    await installer.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return installer;
}

async function waitFor(check, message = 'the worker did not reach the expected state') {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function assertStopped(pid) {
  await waitFor(async () => {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') return true;
      throw error;
    }
    // SIGKILL delivery and orphan reaping are asynchronous on Unix. A Linux
    // zombie cannot run or write, even while its PID awaits collection by init.
    if (process.platform !== 'linux') return false;
    try {
      return /^State:\s+Z\b/m.test(await fs.readFile(`/proc/${pid}/status`, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
  }, `process ${pid} is still running after cleanup`);
}

const descendantWorker = `
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawn } = require('node:child_process');
  let directory;
  process.on('message', (message) => {
    if (message.type === 'install') {
      directory = message.options.gameDirectory;
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`
        const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          windowsHide: true, stdio: 'ignore'
        });
        process.send({ pid: child.pid });
        setInterval(() => {}, 1000);
      `)}], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', ({ pid }) => {
        process.send({ type: 'child-started', pid: child.pid }, () => {
          process.send({ type: 'progress', value: { worker: process.pid, java: child.pid, descendant: pid } });
        });
      });
    } else if (message.type === 'cancel') {
      fs.writeFileSync(path.join(directory, 'cancelled'), 'cancelled');
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(directory, 'release'))) {
          clearInterval(timer);
          fs.writeFileSync(path.join(directory, 'cleanup-complete'), 'complete');
          process.exit(0);
        }
      }, 10);
    }
  });
`;

for (const scope of ['instance', 'global']) {
  test(`${scope} disposal waits for cancellation cleanup and stops the entire Java tree`, async (t) => {
    const installers = await Promise.all(Array.from({ length: scope === 'global' ? 2 : 1 }, () => fixture(t, descendantWorker)));
    const processes = [];
    const started = [];
    const cancelled = installers.map((installer) => {
      let entered;
      started.push(new Promise((resolve) => { entered = resolve; }));
      return assert.rejects(installer.installLoader({}, (value) => { processes.push(value); entered(); }), { code: 'TASK_CANCELLED' });
    });
    await Promise.all(started);
    let disposed = false;
    const stopping = (scope === 'global' ? disposeLoaderInstallProcesses() : installers[0].dispose())
      .then(() => { disposed = true; });
    for (const installer of installers) {
      await waitFor(() => fs.access(path.join(installer.gameDirectory, 'cancelled')).then(() => true, () => false));
    }
    assert.equal(disposed, false, 'disposal must wait until every worker finishes cleanup');
    for (const installer of installers) await fs.writeFile(path.join(installer.gameDirectory, 'release'), 'release');
    await stopping;
    await Promise.all(cancelled);
    for (const installer of installers) {
      assert.equal(await fs.readFile(path.join(installer.gameDirectory, 'cleanup-complete'), 'utf8'), 'complete');
      await assert.rejects(installer.installLoader({}), { code: 'INSTALLER_DISPOSED' });
    }
    for (const value of processes) {
      await Promise.all(Object.values(value).map(assertStopped));
    }
  });
}

test('an unexpected owner exit stops its worker and the entire reported Java tree', async (t) => {
  const installer = await fixture(t, descendantWorker);
  const ownerPath = path.join(installer.gameDirectory, 'owner.cjs');
  const modulePath = require.resolve('../src/main/minecraft/loader-install-process');
  await fs.writeFile(ownerPath, `
    const { LoaderInstallProcess } = require(${JSON.stringify(modulePath)});
    const installer = new LoaderInstallProcess(${JSON.stringify({ workerPath: installer.workerPath, gameDirectory: installer.gameDirectory })});
    void installer.installLoader({}, (value) => process.send(value, () => process.exit(29)));
  `);
  const owner = fork(ownerPath, [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  let processes;
  owner.on('message', (value) => { processes = value; });
  const exitCode = await new Promise((resolve, reject) => {
    owner.once('error', reject);
    owner.once('close', resolve);
  });
  assert.equal(exitCode, 29);
  assert.ok(processes);
  await Promise.all(Object.values(processes).map(assertStopped));
});

test('a busy installation has a separate process while the caller remains responsive', async (t) => {
  const installer = await fixture(t, `
    process.once('message', ({ options, request }) => {
      process.send({ type: 'progress', value: { phase: 'installing-loader', pid: process.pid } });
      const until = Date.now() + 200;
      while (Date.now() < until) { /* Exercise a blocked installation event loop. */ }
      process.send({ type: 'result', value: { profileId: request.gameVersion, directory: options.gameDirectory } }, () => process.exit(0));
    });
  `);
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let finished = false;
  const pending = installer.installLoader({ gameVersion: '1.21.1' }, (value) => {
    assert.notEqual(value.pid, process.pid);
    entered();
  }).then((value) => { finished = true; return value; });
  await started;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false, 'the main event loop can respond while installation is busy');
  assert.deepEqual(await pending, { profileId: '1.21.1', directory: installer.gameDirectory });
});

test('worker errors preserve retry and installer log details and a subsequent installation can run', async (t) => {
  const installer = await fixture(t, `
    process.once('message', ({ request }) => process.send(request.fail
      ? { type: 'error', value: { message: 'Forge failed', code: 'INSTALLER_FAILED', phase: 'installing-loader',
          retryable: true, details: { logPath: '/logs/forge.log' } } }
      : { type: 'result', value: { profileId: 'retry' } }, () => process.exit(0)));
  `);
  await assert.rejects(installer.installLoader({ fail: true }), (error) => {
    assert.equal(error.code, 'INSTALLER_FAILED');
    assert.equal(error.retryable, true);
    assert.equal(error.details.logPath, '/logs/forge.log');
    return true;
  });
  assert.equal((await installer.installLoader({})).profileId, 'retry');
});

test('an unexpected worker exit reports a retryable task failure', async (t) => {
  const installer = await fixture(t, `process.once('message', () => process.exit(23));`);
  await assert.rejects(installer.installLoader({}), (error) => {
    assert.equal(error.code, 'INSTALLER_PROCESS_EXITED');
    assert.equal(error.details.exitCode, 23);
    assert.equal(error.retryable, true);
    return true;
  });
});

test('a crashed worker cannot leave its Java descendant writing after the task is released', async (t) => {
  const installer = await fixture(t, `
    process.once('message', () => {
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        windowsHide: true, stdio: 'ignore'
      });
      process.send({ type: 'child-started', pid: child.pid }, () => {
        process.send({ type: 'progress', value: { pid: child.pid } }, () => process.exit(23));
      });
    });
  `);
  let descendant;
  await assert.rejects(installer.installLoader({}, value => { descendant = value.pid; }), { code: 'INSTALLER_PROCESS_EXITED' });
  assert.ok(descendant);
  await assertStopped(descendant);
});

test('cancellation waits for worker cleanup before releasing the installation', async (t) => {
  const installer = await fixture(t, `
    process.on('message', (message) => {
      if (message.type === 'install') process.send({ type: 'progress', value: { phase: 'installing-loader' } });
      else if (message.type === 'cancel') setTimeout(() => process.exit(0), 60);
    });
  `);
  const controller = new AbortController();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let released = false;
  const pending = installer.installLoader({}, () => entered(), { signal: controller.signal });
  const cancelled = assert.rejects(pending, { code: 'TASK_CANCELLED' }).then(() => { released = true; });
  await started;
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(released, false);
  await cancelled;
});

test('a worker that ignores cancellation is terminated and releases the task', async (t) => {
  const installer = await fixture(t, `
    process.on('message', (message) => {
      if (message.type === 'install') process.send({ type: 'progress', value: { phase: 'installing-loader' } });
    });
  `);
  installer.cancelGraceMs = 10;
  const controller = new AbortController();
  const pending = installer.installLoader({}, () => controller.abort(), { signal: controller.signal });
  await assert.rejects(pending, { code: 'TASK_CANCELLED' });
});

test('already cancelled installations never spawn a worker', async () => {
  const controller = new AbortController();
  controller.abort();
  const installer = new LoaderInstallProcess({ forkProcess: () => { throw new Error('must not spawn'); } });
  await assert.rejects(installer.installLoader({}, undefined, { signal: controller.signal }), { code: 'TASK_CANCELLED' });
});

test('the production worker wires the downloader and installation settings into the real loader manager', async (t) => {
  const workerPath = require.resolve('../src/main/minecraft/loader-install-worker');
  const installer = await fixture(t, `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === './downloader' && parent.filename === ${JSON.stringify(workerPath)}) {
        return { MinecraftDownloader: class {
          constructor(options) { this.options = options; }
          async installVersion(versionId, report, { signal }) {
            if (signal.aborted) throw new Error('Unexpected cancellation');
            report({ phase: 'downloading-base', message: 'Fixture download' });
            return { versionId, gameDirectory: this.options.gameDirectory,
              concurrency: this.options.concurrency, segmentConcurrency: this.options.segmentConcurrency,
              source: this.options.sourceManager.downloadPreference };
          }
        } };
      }
      return load.call(this, request, parent, isMain);
    };
    require(${JSON.stringify(workerPath)});
  `);
  Object.assign(installer, { concurrency: 8, segmentConcurrency: 4, downloadSource: 'official' });
  const progress = [];
  const result = await installer.installLoader({ gameVersion: '1.21.1', loaderType: 'vanilla' }, value => progress.push(value));
  assert.equal(result.profileId, '1.21.1');
  assert.equal(result.gameDirectory, installer.gameDirectory);
  assert.equal(result.concurrency, 8);
  assert.equal(result.segmentConcurrency, 4);
  assert.equal(result.source, 'official');
  assert.equal(progress[0].phase, 'downloading-base');
});

for (const runtime of ['node', 'electron']) {
  test(`the production installation worker starts with ${runtime} and reports validation errors without network access`, async () => {
    const installer = new LoaderInstallProcess({
      forkProcess: (filename, args, options) => fork(filename, args, {
        ...options, execPath: runtime === 'electron' ? require('electron') : process.execPath
      })
    });
    await assert.rejects(installer.installLoader({ gameVersion: '../invalid', loaderType: 'forge' }), /Minecraft 版本号格式无效/);
  });
}
