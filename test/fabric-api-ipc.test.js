const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { registerMinecraftIpc, resolveGameDirectory } = require('../src/main/minecraft/ipc');
const { MinecraftLoaderManager } = require('../src/main/minecraft/loader-manager');
const { GameProcessRegistry } = require('../src/main/minecraft/game-process-registry');
const { profileGameDirectory } = require('../src/main/minecraft/launch-target');

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function sender(id) {
  const owner = new EventEmitter();
  let destroyed = false;
  Object.assign(owner, { id, messages: [], isDestroyed: () => destroyed });
  owner.send = (channel, value) => owner.messages.push({ channel, value });
  owner.destroy = () => { destroyed = true; owner.emit('destroyed'); };
  return owner;
}

async function fixture(t, settingsOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-fabric-api-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = { isPackaged: false, getAppPath: () => root, getPath: (name) => path.join(root, name) };
  const settings = { gameDirectoryMode: 'local', downloadSource: 'official', downloadConcurrency: 8,
    isolateProfiles: true, ...settingsOverrides };
  const calls = { created: [], list: [], resolve: [], loader: [], install: [], events: [], settings: 0 };
  const behavior = {};
  const apiVersion = { id: 'api-compatible', versionNumber: '0.123.0+1.21.1', fileName: 'fabric-api.jar' };
  const loaderResult = { profileId: 'actual-fabric-profile', gameVersion: '1.21.1', loaderType: 'fabric', loaderVersion: '0.16.0' };
  let registry;
  class FixtureRegistry extends GameProcessRegistry {
    constructor() { super(); registry = this; }
  }
  class FabricApiManager {
    constructor(options = {}) {
      this.gameDirectory = options.gameDirectory;
      calls.created.push({ directory: this.gameDirectory });
    }
    async listVersions(gameVersion, options = {}) {
      calls.list.push({ gameVersion, options, directory: this.gameDirectory });
      if (behavior.list) return behavior.list.call(this, gameVersion, options);
      return { gameVersion, versions: [apiVersion] };
    }
    async resolveVersion(gameVersion, versionId, options = {}) {
      calls.events.push('resolve');
      calls.resolve.push({ gameVersion, versionId, signal: options.signal, directory: this.gameDirectory });
      if (behavior.resolve) return behavior.resolve.call(this, gameVersion, versionId, options);
      return apiVersion;
    }
    async installVersion(request, progress, options = {}) {
      calls.events.push('api');
      calls.install.push({ ...request, signal: options.signal, directory: this.gameDirectory });
      progress({ phase: 'installing-fabric-api', message: 'Installing Fabric API' });
      if (behavior.install) return behavior.install.call(this, request, progress, options);
      return { ...apiVersion, instanceDirectory: request.instanceDirectory };
    }
  }
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (request, parent, isMain) {
    if (parent?.filename === require.resolve('../src/main/minecraft/ipc')) {
      if (request === './fabric-api-manager') return { FabricApiManager };
      if (request === './game-process-registry') return { GameProcessRegistry: FixtureRegistry };
    }
    return originalLoad.call(this, request, parent, isMain);
  });
  t.mock.method(MinecraftLoaderManager.prototype, 'installLoader', async function (request, progress, options = {}) {
    calls.events.push('loader');
    calls.loader.push({ request, signal: options.signal, directory: this.gameDirectory });
    progress({ phase: 'installing-loader', message: 'Installing Fabric' });
    if (behavior.loader) return behavior.loader.call(this, request, progress, options);
    progress({ phase: 'complete', message: 'Loader complete' });
    return loaderResult;
  });
  const settingsStore = { getState: async () => { calls.settings++; return { ...settings }; } };
  const handlers = new Map();
  registerMinecraftIpc({ app, settingsStore, shell: { trashItem: async () => {} },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) } });
  const owner = sender(1);
  const invokeRaw = (name, currentOwner = owner, ...args) => {
    assert.equal(typeof handlers.get(name), 'function', `${name} must be registered`);
    return handlers.get(name)({ sender: currentOwner }, ...args);
  };
  const invoke = async (name, currentOwner, ...args) => {
    const result = await invokeRaw(name, currentOwner, ...args);
    if (result?.__launcherTaskError) throw Object.assign(new Error(result.__launcherTaskError.message), result.__launcherTaskError);
    return result;
  };
  return { root, app, settings, settingsStore, calls, behavior, apiVersion, loaderResult, owner, registry,
    directories: { local: resolveGameDirectory(app, 'local'), system: resolveGameDirectory(app, 'system') },
    invoke, invokeRaw,
    request: (extra = {}) => ({ gameVersion: '1.21.1', loaderType: 'fabric', loaderVersion: '0.16.0',
      fabricApiVersionId: apiVersion.id, taskId: 'fabric-api-task', ...extra }) };
}

test('Fabric API catalog IPC stays independent of game directories and preserves its structured response', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.invoke('minecraft:list-fabric-api-versions', f.owner, '1.21.1', { force: true }),
    { gameVersion: '1.21.1', versions: [f.apiVersion] });
  assert.equal(f.calls.settings, 0);
  assert.deepEqual(f.calls.created, [{ directory: undefined }]);
  assert.equal(f.calls.list[0].options.force, true);
  assert.equal(f.calls.loader.length, 0);
  f.behavior.list = async () => { throw Object.assign(new Error('Catalog unavailable'), { code: 'FABRIC_API_METADATA_UNAVAILABLE', retryable: true }); };
  const failed = await f.invokeRaw('minecraft:list-fabric-api-versions', f.owner, '1.21.1');
  assert.equal(failed.__launcherTaskError.code, 'FABRIC_API_METADATA_UNAVAILABLE');
  assert.equal(failed.__launcherTaskError.retryable, true);
});

test('omitting Fabric API leaves the original loader installation behavior and result unchanged', async (t) => {
  const f = await fixture(t);
  const request = f.request();
  delete request.fabricApiVersionId;
  const result = await f.invoke('minecraft:install-loader', f.owner, request);
  assert.equal(result, f.loaderResult);
  assert.deepEqual(f.calls.events, ['loader']);
  assert.equal(f.calls.created.length, 0);
  assert.equal(f.owner.messages.at(-1).value.phase, 'complete');
});

for (const isolateProfiles of [true, false]) {
  test(`Fabric API installs into the actual installed profile directory (isolation ${isolateProfiles})`, async (t) => {
    const f = await fixture(t, { isolateProfiles });
    const result = await f.invoke('minecraft:install-loader', f.owner, f.request());
    assert.deepEqual(f.calls.events, ['resolve', 'loader', 'api']);
    assert.equal(result.profileId, f.loaderResult.profileId);
    assert.equal(result.fabricApi.id, f.apiVersion.id);
    assert.equal(f.calls.install[0].instanceDirectory, isolateProfiles
      ? profileGameDirectory(f.directories.local, f.loaderResult.profileId) : f.directories.local);
    assert.equal(f.calls.install[0].directory, f.directories.local);
    assert.equal(f.calls.resolve[0].signal, f.calls.loader[0].signal);
    assert.equal(f.calls.resolve[0].signal, f.calls.install[0].signal);
    const progress = f.owner.messages.filter((message) => message.channel === 'minecraft:download-progress');
    assert.ok(progress.every((message) => message.value.taskId === 'fabric-api-task'));
    assert.equal(progress.at(-1).value.phase, 'complete');
  });
}

test('non-Fabric API requests fail before querying metadata or installing a loader', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('minecraft:install-loader', f.owner, f.request({ loaderType: 'forge' })),
    { code: 'FABRIC_API_INCOMPATIBLE' });
  assert.deepEqual(f.calls.events, []);
});

test('an incompatible API version preserves its error details without first changing the installed loader', async (t) => {
  const f = await fixture(t);
  f.behavior.resolve = async () => { throw Object.assign(new Error('API does not support this Minecraft version'),
    { code: 'FABRIC_API_INCOMPATIBLE', phase: 'resolving-fabric-api', details: { gameVersion: '1.21.1', versionId: 'wrong-api' } }); };
  const failed = await f.invokeRaw('minecraft:install-loader', f.owner, f.request({ fabricApiVersionId: 'wrong-api' }));
  assert.equal(failed.__launcherTaskError.code, 'FABRIC_API_INCOMPATIBLE');
  assert.deepEqual(failed.__launcherTaskError.details, { gameVersion: '1.21.1', versionId: 'wrong-api' });
  assert.deepEqual(f.calls.events, ['resolve']);
});

test('stale directory selections are rejected before either API validation or loader installation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('minecraft:install-loader', f.owner,
    f.request({ expectedGameDirectory: f.directories.system })), { code: 'GAME_DIRECTORY_CHANGED' });
  assert.deepEqual(f.calls.events, []);
  const equivalent = path.join(f.directories.local, 'child', '..');
  await f.invoke('minecraft:install-loader', f.owner, f.request({ expectedGameDirectory: equivalent }));
  assert.equal(f.calls.install[0].directory, f.directories.local);
});

test('a running game blocks API installation only in its own game directory', async (t) => {
  const f = await fixture(t);
  f.registry.forDirectory(f.directories.local).set('fixture', { exitCode: null });
  await assert.rejects(f.invoke('minecraft:install-loader', f.owner, f.request()), { code: 'GAME_RUNNING' });
  assert.deepEqual(f.calls.events, []);
  f.settings.gameDirectoryMode = 'system';
  await f.invoke('minecraft:install-loader', f.owner, f.request());
  assert.equal(f.calls.install[0].directory, f.directories.system);
});

test('API compatibility validation receives task cancellation before any loader is installed', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  f.behavior.resolve = async (_gameVersion, _versionId, { signal }) => {
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort',
      () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true }));
  };
  const pending = f.invoke('minecraft:install-loader', f.owner, f.request());
  const cancelled = assert.rejects(pending, { code: 'TASK_CANCELLED' });
  await entered.promise;
  assert.deepEqual(await f.invoke('minecraft:cancel-download', sender(2), { taskId: 'fabric-api-task' }), { cancelled: 0 });
  assert.deepEqual(await f.invoke('minecraft:cancel-download', f.owner, { taskId: 'fabric-api-task' }), { cancelled: 1 });
  await cancelled;
  assert.equal(f.calls.resolve[0].signal.aborted, true);
  assert.equal(f.calls.loader.length, 0);
  assert.equal(f.owner.listenerCount('destroyed'), 0);
});

test('a cancelled API lookup cannot start a loader even if the metadata provider returns successfully', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const finished = deferred();
  t.after(() => finished.resolve());
  f.behavior.resolve = async () => { entered.resolve(); await finished.promise; return f.apiVersion; };
  const pending = f.invoke('minecraft:install-loader', f.owner, f.request());
  const cancelled = assert.rejects(pending, { code: 'TASK_CANCELLED' });
  await entered.promise;
  await f.invoke('minecraft:cancel-download', f.owner, { taskId: 'fabric-api-task' });
  finished.resolve();
  await cancelled;
  assert.equal(f.calls.loader.length, 0);
  assert.equal(f.calls.install.length, 0);
});

test('cancellation after loader completion cannot continue into Fabric API installation', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const finished = deferred();
  t.after(() => finished.resolve());
  f.behavior.loader = async (_request, progress) => {
    entered.resolve();
    await finished.promise;
    progress({ phase: 'complete', message: 'Loader completed while cancellation arrived' });
    return f.loaderResult;
  };
  const pending = f.invoke('minecraft:install-loader', f.owner, f.request());
  const cancelled = assert.rejects(pending, { code: 'TASK_CANCELLED' });
  await entered.promise;
  await f.invoke('minecraft:cancel-download', f.owner, { taskId: 'fabric-api-task' });
  finished.resolve();
  await cancelled;
  assert.equal(f.calls.install.length, 0);
});

test('loader and API stages retain one owned task and do not publish completion while the API is pending', async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  f.behavior.install = async (_request, _progress, { signal }) => {
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort',
      () => reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true }));
  };
  const pending = f.invoke('minecraft:install-loader', f.owner, f.request());
  const cancelled = assert.rejects(pending, { code: 'TASK_CANCELLED' });
  await entered.promise;
  assert.equal(f.owner.listenerCount('destroyed'), 1);
  assert.equal(f.owner.messages.some((message) => message.value.phase === 'complete'), false);
  await assert.rejects(f.invoke('minecraft:install-loader', sender(2), f.request({ taskId: 'other-task' })), { code: 'TASK_BUSY' });
  assert.deepEqual(await f.invoke('minecraft:cancel-download', f.owner, { taskId: 'fabric-api-task' }), { cancelled: 1 });
  await cancelled;
  assert.equal(f.calls.loader[0].signal, f.calls.install[0].signal);
  assert.equal(f.calls.install[0].signal.aborted, true);
  assert.equal(f.owner.listenerCount('destroyed'), 0);
});

test('a pending API validation preserves the original directory and isolation settings snapshot', async (t) => {
  const f = await fixture(t, { isolateProfiles: true });
  const entered = deferred();
  const finished = deferred();
  t.after(() => finished.resolve());
  f.behavior.resolve = async () => { entered.resolve(); await finished.promise; return f.apiVersion; };
  const pending = f.invoke('minecraft:install-loader', f.owner, f.request());
  await entered.promise;
  f.settings.gameDirectoryMode = 'system';
  f.settings.isolateProfiles = false;
  await assert.rejects(f.invoke('minecraft:list-local-versions', sender(2)), /切换游戏目录/);
  finished.resolve();
  await pending;
  assert.equal(f.calls.loader[0].directory, f.directories.local);
  assert.equal(f.calls.install[0].directory, f.directories.local);
  assert.equal(f.calls.install[0].instanceDirectory, profileGameDirectory(f.directories.local, f.loaderResult.profileId));
  assert.ok(f.calls.created.every((entry) => entry.directory === f.directories.local));
});
