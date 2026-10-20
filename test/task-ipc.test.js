const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { registerMinecraftIpc, resolveGameDirectory } = require('../src/main/minecraft/ipc');
const { MinecraftDownloader } = require('../src/main/minecraft/downloader');
const { MinecraftVersionManager } = require('../src/main/minecraft/version-manager');
const { ManagedJavaRuntime } = require('../src/main/minecraft/managed-java-runtime');
const { ModpackManager } = require('../src/main/minecraft/modpack-manager');

function deferred() {
  let resolve;
  const promise = new Promise(settle => { resolve = settle; });
  return { promise, resolve };
}

function sender(id) {
  const result = new EventEmitter();
  let destroyed = false;
  result.id = id;
  result.messages = [];
  result.isDestroyed = () => destroyed;
  result.send = (channel, value) => result.messages.push({ channel, value });
  result.destroy = () => { destroyed = true; result.emit('destroyed'); };
  return result;
}

async function fixture(t, extras = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-task-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = { isPackaged: false, getAppPath: () => root, getPath: name => path.join(root, name) };
  const settings = { gameDirectoryMode: 'local', downloadSource: 'auto', downloadConcurrency: 16, javaPath: '' };
  const settingsStore = { getState: async () => ({ ...settings }) };
  const handlers = new Map();
  registerMinecraftIpc({ app, settingsStore, shell: { trashItem: async () => {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, ...extras });
  return { settings, settingsStore, app,
    invoke: async (name, owner, ...args) => {
      const result = await handlers.get(name)({ sender: owner }, ...args);
      if (result?.__launcherTaskError) {
        throw Object.assign(new Error(result.__launcherTaskError.message), result.__launcherTaskError);
      }
      return result;
    } };
}

test('game tasks register before settings resolve, reject duplicates and accept only their owner and task cancellation', async t => {
  const f = await fixture(t), owner = sender(1), other = sender(2), ready = deferred();
  let reads = 0, inspected = 0;
  t.mock.method(f.settingsStore, 'getState', async () => {
    if (++reads === 1) await ready.promise;
    return { ...f.settings };
  });
  t.mock.method(ModpackManager.prototype, 'inspect', async (_filePath, { signal }) => {
    inspected++; assert.equal(signal.aborted, false); return { name: 'Pack' };
  });
  const pending = f.invoke('minecraft:inspect-modpack', owner, 'pack.zip', { taskId: 'preview' });
  const cancelled = assert.rejects(pending, error => error.code === 'TASK_CANCELLED');
  await assert.rejects(f.invoke('minecraft:install-modpack', other, 'other.zip'), error => error.code === 'TASK_BUSY');
  assert.deepEqual(await f.invoke('minecraft:cancel-download', other, { taskId: 'preview' }), { cancelled: 0 });
  assert.deepEqual(await f.invoke('minecraft:cancel-download', owner, { taskId: 'stale-task' }), { cancelled: 0 });
  assert.deepEqual(await f.invoke('minecraft:cancel-download', owner, { taskId: 'preview' }), { cancelled: 1 });
  assert.equal(inspected, 0);
  ready.resolve(); await cancelled;
  assert.equal(inspected, 0);
  assert.equal(owner.listenerCount('destroyed'), 0);
  assert.equal(owner.messages[0].value.taskId, 'preview');
  assert.equal(owner.messages[0].value.phase, 'preparing');
  assert.deepEqual(await f.invoke('minecraft:inspect-modpack', owner, 'pack.zip', { taskId: 'preview' }), { name: 'Pack' });
});

test('canceling while a native missing-file chooser is open never imports a later selection', async t => {
  const chosen = deferred(), opened = deferred();
  const f = await fixture(t, { dialog: { showOpenDialog: async () => { opened.resolve(); return chosen.promise; } } });
  const owner = sender(3);
  let imports = 0;
  t.mock.method(ModpackManager.prototype, 'getRecoveryState', (_id, options) => {
    assert.equal(options.ownerId, owner.id); return { status: 'waiting-for-files' };
  });
  t.mock.method(ModpackManager.prototype, 'importMissingFile', async () => { imports++; });
  const pending = f.invoke('minecraft:select-missing-modpack-file', owner, 'session', { projectId: 1, fileId: 2 },
    { taskId: 'select-file' });
  const cancelled = assert.rejects(pending, error => error.code === 'TASK_CANCELLED');
  await opened.promise;
  assert.equal(owner.messages[0].value.taskId, 'select-file');
  assert.deepEqual(await f.invoke('minecraft:cancel-download', owner, { taskId: 'select-file' }), { cancelled: 1 });
  chosen.resolve({ canceled: false, filePaths: [path.resolve('manual.jar')] });
  await cancelled;
  assert.equal(imports, 0);
  assert.equal(owner.listenerCount('destroyed'), 0);
});

test('parallel Java and game settings snapshots cannot rebind services to different directories after the first task binds', async t => {
  const f = await fixture(t), owner = sender(4), settingsReady = [deferred(), deferred()], javaDone = deferred();
  const javaStarted = deferred(), gameDirectories = [];
  let reads = 0;
  t.after(() => javaDone.resolve('java-path'));
  t.mock.method(f.settingsStore, 'getState', async () => {
    const index = reads++;
    if (index < 2) {
      await settingsReady[index].promise;
      return { ...f.settings, gameDirectoryMode: index === 0 ? 'local' : 'system' };
    }
    return { ...f.settings, gameDirectoryMode: 'system' };
  });
  t.mock.method(ManagedJavaRuntime.prototype, 'ensureInstalled', async function () {
    assert.equal(this.gameDirectory, resolveGameDirectory(f.app, 'local'));
    javaStarted.resolve(); return javaDone.promise;
  });
  t.mock.method(MinecraftDownloader.prototype, 'installVersion', async function () {
    gameDirectories.push(this.gameDirectory); return { versionId: 'base' };
  });
  const java = f.invoke('minecraft:download-java', owner, 21, { taskId: 'java' });
  const game = f.invoke('minecraft:download-version', owner, 'base', { taskId: 'game' });
  const conflict = assert.rejects(game, /切换游戏目录/);
  settingsReady[0].resolve(); settingsReady[1].resolve();
  await javaStarted.promise; await conflict;
  assert.deepEqual(gameDirectories, []);
  javaDone.resolve('java-path'); await java;
  await f.invoke('minecraft:download-version', owner, 'base', { taskId: 'retry-game' });
  assert.deepEqual(gameDirectories, [resolveGameDirectory(f.app, 'system')]);
});

test('the same external task ID keeps parallel Java and game registry entries independently cancellable', async t => {
  const f = await fixture(t), owner = sender(5), javaStarted = deferred(), gameStarted = deferred();
  const completions = [], signals = {};
  t.after(() => completions.forEach(resolve => resolve('done')));
  const wait = signal => new Promise((resolve, reject) => {
    completions.push(resolve);
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  t.mock.method(ManagedJavaRuntime.prototype, 'ensureInstalled', async (_major, _progress, signal) => {
    signals.java = signal; javaStarted.resolve(); return wait(signal);
  });
  t.mock.method(MinecraftDownloader.prototype, 'installVersion', async (_version, _progress, { signal }) => {
    signals.game = signal; gameStarted.resolve(); return wait(signal);
  });
  const java = f.invoke('minecraft:download-java', owner, 21, { taskId: 'same-id' });
  const game = f.invoke('minecraft:download-version', owner, 'base', { taskId: 'same-id' });
  const javaCancelled = assert.rejects(java, error => error.code === 'TASK_CANCELLED');
  const gameCancelled = assert.rejects(game, error => error.code === 'TASK_CANCELLED');
  await Promise.all([javaStarted.promise, gameStarted.promise]);
  assert.deepEqual(await f.invoke('minecraft:cancel-java-download', owner), { cancelled: 1 });
  await javaCancelled;
  assert.equal(signals.game.aborted, false);
  assert.deepEqual(await f.invoke('minecraft:cancel-download', owner, { taskId: 'same-id' }), { cancelled: 1 });
  await gameCancelled;
  assert.equal(owner.listenerCount('destroyed'), 0);
});

test('a reported commit boundary stays noncancellable even if later progress omits or enables cancellation', async t => {
  const f = await fixture(t), owner = sender(6), started = deferred(), done = deferred();
  let signal;
  t.after(() => done.resolve({ status: 'complete', targetId: 'instance-pack' }));
  t.mock.method(ModpackManager.prototype, 'install', async (_path, report, options) => {
    signal = options.signal;
    report({ phase: 'committing-instance', cancellable: false });
    report({ phase: 'complete', cancellable: true });
    started.resolve(); return done.promise;
  });
  const task = f.invoke('minecraft:install-modpack', owner, 'pack.zip', { taskId: 'commit' });
  await started.promise;
  assert.deepEqual(await f.invoke('minecraft:cancel-download', owner, { taskId: 'commit' }), { cancelled: 0, committing: true });
  assert.equal(signal.aborted, false);
  assert.equal(owner.messages.at(-1).value.cancellable, false);
  done.resolve({ status: 'complete', targetId: 'instance-pack' });
  assert.deepEqual(await task, { status: 'complete', targetId: 'instance-pack' });
});

test('idle recovery ownership survives task completion and is released on window close or directory changes', async t => {
  const f = await fixture(t), closedOwner = sender(7), changedOwner = sender(8), discarded = [];
  const waiting = { status: 'waiting-for-files', sessionId: 'waiting', files: [] };
  t.mock.method(ModpackManager.prototype, 'install', async () => waiting);
  t.mock.method(ModpackManager.prototype, 'resume', async () => waiting);
  t.mock.method(ModpackManager.prototype, 'discardOwnerSessions', function (ownerId) {
    discarded.push({ ownerId, directory: this.gameDirectory });
  });
  t.mock.method(MinecraftVersionManager.prototype, 'listLocalProfiles', async () => []);
  await f.invoke('minecraft:install-modpack', closedOwner, 'pack.zip');
  await f.invoke('minecraft:resume-modpack', closedOwner, 'waiting');
  assert.equal(closedOwner.listenerCount('destroyed'), 1);
  closedOwner.destroy();
  assert.equal(closedOwner.listenerCount('destroyed'), 0);
  assert.equal(discarded.filter(entry => entry.ownerId === closedOwner.id).length, 2);
  await f.invoke('minecraft:install-modpack', changedOwner, 'pack.zip');
  assert.equal(changedOwner.listenerCount('destroyed'), 1);
  f.settings.gameDirectoryMode = 'system';
  await f.invoke('minecraft:list-local-versions', changedOwner);
  assert.equal(changedOwner.listenerCount('destroyed'), 0);
  assert.equal(discarded.filter(entry => entry.ownerId === changedOwner.id).length, 2);
  assert.ok(discarded.every(entry => entry.directory === resolveGameDirectory(f.app, 'local')));
});
