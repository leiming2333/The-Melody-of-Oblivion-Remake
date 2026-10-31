const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { registerMinecraftIpc, resolveGameDirectory } = require('../src/main/minecraft/ipc');
const launchCore = require('../src/main/minecraft/launch-core');
const { ModManager } = require('../src/main/minecraft/mod-manager');

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Game process lifecycle did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(t, { holdJava = false, accountType = 'offline', microsoftAuth } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-directory-lifecycle-'));
  const settings = { gameDirectoryMode: 'local', memoryMb: 2048, isolateProfiles: false };
  const app = { isPackaged: false, getAppPath: () => root, getPath: (name) => path.join(root, name) };
  const directories = { local: resolveGameDirectory(app, 'local'), system: resolveGameDirectory(app, 'system') };
  for (const directory of Object.values(directories)) {
    const profile = path.join(directory, 'versions', 'fixture');
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, 'fixture.json'), JSON.stringify({ id: 'fixture', mainClass: 'FixtureMain', libraries: [] }));
    await fs.writeFile(path.join(profile, 'fixture.jar'), 'fixture client');
  }

  const children = [];
  const launchers = [];
  let releaseJava;
  let enteredJava;
  const javaReleased = new Promise((resolve) => { releaseJava = resolve; });
  const javaStarted = new Promise((resolve) => { enteredJava = resolve; });
  let nextPid = 100;
  function spawnProcess(_executable, _arguments, options) {
    const child = new EventEmitter();
    Object.assign(child, { pid: nextPid++, cwd: options.cwd, exitCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter(), unref() {} });
    child.finish = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      child.emit('close', 0, null);
    };
    children.push(child);
    process.nextTick(() => child.emit('spawn'));
    return child;
  }
  class FixtureLauncher extends launchCore.MinecraftLauncher {
    constructor(options) {
      super({ ...options, findJava: async () => {
        enteredJava();
        if (holdJava) await javaReleased;
        return 'fixture-java';
      }, spawnProcess });
      launchers.push(this);
    }
  }
  const load = Module._load;
  t.mock.method(Module, '_load', function (request, parent, isMain) {
    if (request === './launch-core' && parent?.filename === require.resolve('../src/main/minecraft/ipc')) {
      return { ...launchCore, MinecraftLauncher: FixtureLauncher };
    }
    return load.call(this, request, parent, isMain);
  });
  const mutations = [];
  t.mock.method(ModManager.prototype, 'setEnabled', async function (directory, name, enabled) {
    mutations.push({ directory, name, enabled });
    return [];
  });
  const trashed = [];
  const owner = new EventEmitter();
  Object.assign(owner, { id: 1, isDestroyed: () => false, messages: [] });
  owner.send = (channel, value) => owner.messages.push({ channel, value });
  const handlers = new Map();
  registerMinecraftIpc({ app,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    settingsStore: { getState: async () => ({ ...settings }) },
    accountStore: { getCurrentAccount: async () => ({ type: accountType, id: 'fixture-account', name: 'FixturePlayer', uuid: '0'.repeat(32) }) },
    microsoftAuth,
    shell: { trashItem: async (file) => trashed.push(file) }
  });
  t.after(async () => {
    releaseJava();
    // Close callbacks finish their log writes before releasing ownership.
    await until(() => {
      children.forEach((child) => child.finish());
      return launchers.every((launcher) => launcher.activeGames.size === 0);
    });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { directories, children, launchers, mutations, trashed, owner, javaStarted, releaseJava,
    invokeRaw: (name, ...args) => handlers.get(name)({ sender: owner }, ...args),
    invoke: async (name, ...args) => {
      const result = await handlers.get(name)({ sender: owner }, ...args);
      if (result?.__launcherTaskError) {
        throw Object.assign(new Error(result.__launcherTaskError.message), result.__launcherTaskError);
      }
      return result;
    },
    async switchTo(mode) {
      settings.gameDirectoryMode = mode;
      await handlers.get('minecraft:list-local-versions')({ sender: owner });
    }
  };
}

test('switching away and back preserves Mod and deletion protection for a running game', async (t) => {
  const f = await fixture(t);
  await f.invoke('minecraft:launch-version', 'fixture');
  await assert.rejects(f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true), /关闭游戏/);
  await assert.rejects(f.invoke('minecraft:delete-version', 'fixture'), /关闭游戏|运行/);
  await f.switchTo('system');
  await f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true);
  await f.invoke('minecraft:delete-version', 'fixture');
  assert.equal(f.mutations.length, 1);
  assert.equal(f.mutations[0].directory, f.directories.system);
  assert.deepEqual(f.trashed, [path.join(f.directories.system, 'versions', 'fixture')]);
  await f.switchTo('local');
  await assert.rejects(f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', false), /关闭游戏/);
  await assert.rejects(f.invoke('minecraft:delete-version', 'fixture'), /关闭游戏|运行/);
  assert.equal(f.mutations.length, 1);
  assert.equal(f.trashed.length, 1);
});

test('reconstructed services reject duplicate games while equal IDs in another directory remain independent', async (t) => {
  const f = await fixture(t);
  await f.invoke('minecraft:launch-version', 'fixture');
  await f.switchTo('system');
  await f.invoke('minecraft:launch-version', 'fixture');
  assert.equal(f.children.length, 2);
  await f.switchTo('local');
  await assert.rejects(f.invoke('minecraft:launch-version', 'fixture'), /已经在运行/);
  assert.equal(f.children.length, 2);
  // A duplicate is rejected before another launcher is constructed. Starting
  // another local target exercises an actual reconstructed local service.
  const otherProfile = path.join(f.directories.local, 'versions', 'other-profile');
  await fs.mkdir(otherProfile, { recursive: true });
  await fs.writeFile(path.join(otherProfile, 'other-profile.json'), JSON.stringify({ id: 'other-profile', mainClass: 'Main' }));
  await fs.writeFile(path.join(otherProfile, 'other-profile.jar'), 'other client');
  await f.invoke('minecraft:launch-version', 'other-profile');
  assert.equal(f.children.length, 3);
  assert.equal(f.launchers.at(-1).gameDirectory, f.directories.local);
  assert.equal(f.launchers[0].activeGames, f.launchers.at(-1).activeGames);
  assert.notEqual(f.launchers[0].activeGames, f.launchers[1].activeGames);
});

test('old-directory exit events retain their directory and cannot clear the other directory process', async (t) => {
  const f = await fixture(t);
  await f.invoke('minecraft:launch-version', 'fixture');
  await f.switchTo('system');
  await f.invoke('minecraft:launch-version', 'fixture');
  const oldLauncher = f.launchers[0];
  f.children[0].finish();
  await until(() => oldLauncher.activeGames.size === 0);
  const statuses = f.owner.messages.filter((message) => message.channel === 'minecraft:launch-status').map((message) => message.value);
  assert.equal(statuses.find((status) => status.phase === 'exited').gameDirectory, f.directories.local);
  assert.ok(statuses.some((status) => status.phase === 'running' && status.gameDirectory === f.directories.system));
  await assert.rejects(f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true), /关闭游戏/);
  await f.switchTo('local');
  await f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true);
  assert.equal(f.mutations[0].directory, f.directories.local);
});

test('preparing games reserve ownership before Java selection and retain protection across directory changes', async (t) => {
  const f = await fixture(t, { holdJava: true });
  const pending = f.invoke('minecraft:launch-version', 'fixture');
  await f.javaStarted;
  assert.equal(f.children.length, 0);
  await assert.rejects(f.invoke('minecraft:launch-version', 'fixture'), /已经在运行/);
  await assert.rejects(f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true), /关闭游戏/);
  await assert.rejects(f.invoke('minecraft:delete-version', 'fixture'), /关闭游戏|运行/);
  await f.switchTo('system');
  await f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true);
  await f.switchTo('local');
  await assert.rejects(f.invoke('minecraft:launch-version', 'fixture'), /已经在运行/);
  f.releaseJava();
  await pending;
  assert.equal(f.children.length, 1);
});

test('launch IPC preserves missing-resource error codes and repair details without spawning Java', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directories.local, 'versions/fixture/fixture.json'), JSON.stringify({
    id: 'fixture', mainClass: 'FixtureMain', libraries: [],
    assetIndex: { id: 'missing', url: 'https://fixture.test/missing-index', sha1: '0'.repeat(40), size: 2 }
  }));
  const result = await f.invokeRaw('minecraft:launch-version', 'fixture');
  assert.equal(result.__launcherTaskError.code, 'GAME_FILES_INCOMPLETE');
  assert.equal(result.__launcherTaskError.phase, 'verifying');
  assert.equal(result.__launcherTaskError.retryable, true);
  assert.ok(result.__launcherTaskError.details.missingFiles.some((name) => name.includes('资源索引')));
  assert.equal(f.children.length, 0);
  // The failed preparation must release its reservation for a future repair/retry.
  await assert.rejects(f.invoke('minecraft:launch-version', 'fixture'), { code: 'GAME_FILES_INCOMPLETE' });
});

test('authentication pending across a directory switch keeps the original target and preparation guards', async (t) => {
  let releaseAuthentication;
  let enteredAuthentication;
  const authenticationReleased = new Promise((resolve) => { releaseAuthentication = resolve; });
  const authenticationStarted = new Promise((resolve) => { enteredAuthentication = resolve; });
  t.after(() => releaseAuthentication());
  const f = await fixture(t, { accountType: 'microsoft', microsoftAuth: {
    ensureAccount: async (account) => {
      enteredAuthentication();
      await authenticationReleased;
      return account;
    }
  } });
  const pending = f.invoke('minecraft:launch-version', 'fixture');
  await authenticationStarted;
  assert.equal(f.launchers.length, 0, 'authentication does not initialize the launcher core');
  await assert.rejects(f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true), /关闭游戏/);
  await assert.rejects(f.invoke('minecraft:delete-version', 'fixture'), /关闭游戏|运行/);
  await assert.rejects(f.invoke('minecraft:launch-version', 'fixture'), /已经在运行/);
  await f.switchTo('system');
  await f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true);
  releaseAuthentication();
  await pending;
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].cwd, f.directories.local);
  assert.equal(f.launchers[0].gameDirectory, f.directories.local);
  const running = f.owner.messages.find((message) => message.channel === 'minecraft:launch-status' && message.value.phase === 'running');
  assert.equal(running.value.gameDirectory, f.directories.local);
  await f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', false);
  await f.switchTo('local');
  await assert.rejects(f.invoke('minecraft:set-mod-enabled', 'fixture', 'example.jar', true), /关闭游戏/);
});
