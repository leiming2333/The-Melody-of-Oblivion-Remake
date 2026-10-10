const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLazyServices } = require('../src/main/lazy-services');
const { registerAccountIpc } = require('../src/main/accounts/ipc');
const { registerSettingsIpc } = require('../src/main/settings/ipc');
const { registerMinecraftIpc } = require('../src/main/minecraft/ipc');
const { registerUpdateIpc } = require('../src/main/updater/ipc');

test('IPC registration leaves every business implementation unloaded', () => {
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const handlers = new Map();
    const ipcMain = { handle: (name, fn) => { assert.ok(!handlers.has(name)); handlers.set(name, fn); } };
    const unexpected = () => { throw new Error('service requested during registration'); };
    const options = { ipcMain, getAccountStore: unexpected, getSettingsStore: unexpected,
      getMicrosoftAuth: unexpected, getYggdrasilAuth: unexpected, getJavaProbeCache: unexpected, getUpdateManager: unexpected };
    require('./src/main/accounts/ipc').registerAccountIpc(options);
    require('./src/main/settings/ipc').registerSettingsIpc(options);
    require('./src/main/minecraft/ipc').registerMinecraftIpc(options);
    const { registerUpdateIpc } = require('./src/main/updater/ipc');
    registerUpdateIpc(options);
    const count = handlers.size;
    registerUpdateIpc(options);
    assert.equal(handlers.size, count);
    for (const name of ['accounts/microsoft-auth', 'accounts/account-store', 'accounts/yggdrasil-auth', 'settings/settings-store',
      'updater/update-manager', 'minecraft/java-probe-cache', 'minecraft/java-runtime',
      'minecraft/version-metadata', 'minecraft/launch-target', 'minecraft/version-manager',
      'minecraft/downloader', 'minecraft/modpack-manager', 'minecraft/loader-manager',
      'minecraft/managed-java-runtime', 'minecraft/launch-core']) {
      assert.equal(require.cache[require.resolve('./src/main/' + name)], undefined, name);
    }
  `], { cwd: path.resolve(__dirname, '..'), timeout: 10000 });
});

test('account requests share a lazy store, retry failures, and resolve auth only for login', async () => {
  const created = [];
  let failed = false;
  const state = { currentId: 'offline' };
  const registry = createLazyServices({
    store: () => {
      created.push('store');
      if (!failed) { failed = true; throw new Error('retry'); }
      return { getState: async () => state };
    },
    auth: () => {
      created.push('auth');
      return { login: async () => ({ sessionId: 'session' }),
        selectProfile: async (...args) => args, cancelOwner: (id) => created.push(id) };
    }
  });
  const handlers = new Map();
  registerAccountIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    getAccountStore: () => registry.store, getYggdrasilAuth: () => registry.auth });
  assert.deepEqual(created, []);
  assert.throws(() => handlers.get('accounts:get-state')(), /retry/);
  assert.equal(await handlers.get('accounts:get-state')(), state);
  assert.equal(await handlers.get('accounts:get-state')(), state);
  assert.deepEqual(created, ['store', 'store']);
  const sender = new EventEmitter();
  sender.id = 7;
  await handlers.get('accounts:login-littleskin')({ sender }, 'user', 'password');
  assert.deepEqual(await handlers.get('accounts:select-littleskin-profile')({ sender }, 'session', 'profile'),
    ['session', 7, 'profile']);
  sender.emit('destroyed');
  assert.deepEqual(created, ['store', 'store', 'auth', 7]);
});

test('lazy service load callback runs once after successful instantiation', () => {
  const loaded = [];
  let calls = 0;
  const registry = createLazyServices({ store: () => ({ id: ++calls }) }, {
    onLoaded: (name) => loaded.push(name)
  });
  assert.deepEqual(loaded, []);
  const instance = registry.store;
  assert.equal(registry.store, instance);
  assert.equal(calls, 1);
  assert.deepEqual(loaded, ['store']);
});

test('settings and update IPC resolve services on demand and preserve current update policy', async () => {
  const handlers = new Map();
  const calls = [];
  let policy = 'notify';
  const store = { getState: async () => ({ launcherUpdatePolicy: policy }), update: async (patch) => patch };
  const manager = { settingsStore: store, publicState: () => ({ status: 'idle' }),
    check: async (options) => options, download: async () => 'download', install: async () => 'install' };
  const options = { ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    getSettingsStore: () => { calls.push('settings'); return store; },
    getJavaProbeCache: () => { throw new Error('unexpected Java request'); },
    getUpdateManager: () => { calls.push('update'); return manager; } };
  registerSettingsIpc(options);
  registerUpdateIpc(options);
  assert.deepEqual(calls, []);
  assert.deepEqual(await handlers.get('settings:update')({}, { memoryMb: 4096 }), { memoryMb: 4096 });
  assert.deepEqual(await handlers.get('settings:get-state')(), { launcherUpdatePolicy: 'notify' });
  assert.deepEqual(handlers.get('updater:get-state')(), { status: 'idle' });
  assert.deepEqual(await handlers.get('updater:check')(), { autoDownload: false });
  policy = 'auto';
  assert.deepEqual(await handlers.get('updater:check')(), { autoDownload: true });
  assert.equal(await handlers.get('updater:download')(), 'download');
  assert.equal(await handlers.get('updater:install')(), 'install');
});

test('main creates a window with all IPC registered before loading business services', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-main-lazy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify({ launcherUpdatePolicy: 'off' }));
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    const Module = require('node:module');
    const load = Module._load;
    const handlers = new Map();
    const app = new EventEmitter();
    Object.assign(app, { whenReady: () => Promise.resolve(), getPath: () => process.argv[1],
      getAppPath: () => process.cwd(), setAppUserModelId() {}, isPackaged: false });
    let created = false;
    class BrowserWindow extends EventEmitter {
      constructor() {
        super();
        created = true;
        for (const name of ['accounts:get-state', 'settings:get-state', 'minecraft:detect-java', 'updater:get-state'])
          assert.ok(handlers.has(name), name);
        for (const name of ['accounts/account-store', 'accounts/yggdrasil-auth', 'settings/settings-store',
          'updater/update-manager', 'minecraft/java-runtime', 'minecraft/java-probe-cache'])
          assert.equal(require.cache[require.resolve('./src/main/' + name)], undefined, name);
      }
      loadFile() {}
    }
    Module._load = function(name, ...args) {
      if (name === 'electron') return { app, BrowserWindow,
        ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) } };
      return load.call(this, name, ...args);
    };
    require('./src/main/main');
    setImmediate(() => assert.equal(created, true));
  `, directory], { cwd: path.resolve(__dirname, '..'), timeout: 10000 });
});
