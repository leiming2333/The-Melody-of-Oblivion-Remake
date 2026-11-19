const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { once } = require('node:events');
const { BackgroundUpdater } = require('../src/main/updater/background-updater');
const { BackgroundSettings } = require('../src/main/settings/background-settings');
const { registerUpdateIpc } = require('../src/main/updater/ipc');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-background-updater-'));
  const events = [];
  const app = { isPackaged: false, getVersion: () => '1.9.8', getPath: (name) => path.join(root, name),
    quit() {}, relaunch() {} };
  const updater = new BackgroundUpdater({ app, shell: { trashItem: async () => {} },
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (...args) => events.push(args) } }] }, ...options });
  updater.process.options.env = {};
  t.after(async () => {
    await updater.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, updater, events };
}

test('the real update worker initializes and serves development state and history without network access', async (t) => {
  const { updater, events } = await fixture(t);
  assert.equal(updater.process.worker, null);
  assert.equal((await updater.initialize()).status, 'unavailable');
  assert.notEqual(updater.process.worker.child.pid, process.pid);
  assert.equal((await updater.check({ autoDownload: false })).status, 'unavailable');
  assert.equal(updater.publicState().currentVersion, '1.9.8');
  assert.deepEqual(await updater.listHistory(), []);
  assert.deepEqual(await updater.cleanupHistory([]), { removed: [], skipped: [] });
  assert.ok(events.some(([channel, value]) => channel === 'updater:state' && value.status === 'unavailable'));
});

test('a crashed update worker clears cancellation state and the facade starts a new worker on retry', async (t) => {
  const { updater } = await fixture(t);
  await updater.initialize();
  const firstPid = updater.process.worker.child.pid;
  updater.state = { ...updater.state, status: 'downloading', canCancel: true };
  const stopped = once(updater.process, 'stopped');
  updater.process.worker.child.kill();
  await stopped;
  assert.equal(updater.publicState().status, 'error');
  assert.equal(updater.publicState().canCancel, false);
  assert.equal((await updater.initialize()).status, 'unavailable');
  assert.notEqual(updater.process.worker.child.pid, firstPid);
});

test('manual update checks survive a failed settings module without enabling automatic downloads', async (t) => {
  const { root, updater } = await fixture(t);
  const filePath = path.join(root, 'settings.json');
  const damaged = '{damaged-settings';
  await fs.writeFile(filePath, damaged);
  const settings = new BackgroundSettings(filePath);
  updater.settingsStore = settings;
  const handlers = new Map();
  registerUpdateIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getUpdateManager: () => updater });
  const calls = [];
  const check = updater.check.bind(updater);
  t.mock.method(updater, 'check', (options) => { calls.push(options); return check(options); });
  try {
    const result = await handlers.get('updater:check')();
    assert.equal(result.status, 'unavailable', 'the actual update process still responds');
    assert.deepEqual(calls, [{ autoDownload: false }]);
    assert.equal(await fs.readFile(filePath, 'utf8'), damaged);
    assert.notEqual(updater.process.worker.child.pid, settings.process.worker.child.pid);

    await fs.writeFile(filePath, JSON.stringify({ version: 3, launcherUpdatePolicy: 'auto' }));
    assert.equal((await handlers.get('updater:check')()).status, 'unavailable');
    assert.deepEqual(calls, [{ autoDownload: false }, { autoDownload: true }]);
  } finally {
    await settings.dispose();
  }
});

test('updater helper handoff preserves the journal, main process PID and native filesystem services', async (t) => {
  const { root, updater } = await fixture(t);
  const realWorkerModule = require.resolve('../src/main/worker-modules/updater');
  const modulePath = path.join(root, 'updater-fixture.cjs');
  await fs.writeFile(modulePath, `
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === '../updater/update-manager' && parent.filename === ${JSON.stringify(realWorkerModule)}) {
        return { UpdateManager: class {
          constructor(options) { this.options = options; }
          async install() {
            const record = { id: 'fixture-update', stagingRoot: ${JSON.stringify(root)} };
            await this.options.startHelper({ record, store: { filePath: ${JSON.stringify(path.join(root, 'journal.json'))},
              records: [record], persistent: true }, platform: 'win32', rollback: true,
              signal: new AbortController().signal });
            return { installing: true, parentPid: this.options.parentPid, workerPid: process.pid };
          }
        } };
      }
      return original.call(this, request, parent, isMain);
    };
    module.exports = require(${JSON.stringify(realWorkerModule)});
  `);
  updater.process.modulePath = modulePath;
  const original = Module._load;
  const helpers = [];
  t.mock.method(Module, '_load', function (request, parent, isMain) {
    if (request === './install-helper' && parent?.filename === require.resolve('../src/main/updater/background-updater')) {
      return {
        startInstallHelper: async (options) => { helpers.push(options); return { kill() {} }; },
        startWindowsHelper: async () => { throw new Error('Transaction helper must be selected'); }
      };
    }
    return original.call(this, request, parent, isMain);
  });
  const result = await updater.install();
  assert.equal(result.installing, true);
  assert.equal(result.parentPid, process.pid);
  assert.notEqual(result.workerPid, process.pid);
  assert.equal(helpers.length, 1);
  assert.equal(helpers[0].parentPid, process.pid);
  assert.equal(helpers[0].store.persistent, true);
  assert.equal(helpers[0].store.filePath, path.join(root, 'journal.json'));
  assert.equal(typeof helpers[0].store.fs.writeFile, 'function');
  assert.equal(helpers[0].store.records[0].id, 'fixture-update');
  assert.equal(helpers[0].rollback, true);
});
