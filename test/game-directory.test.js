const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { MinecraftDownloader } = require('../src/main/minecraft/downloader');
const { ManagedJavaRuntime } = require('../src/main/minecraft/managed-java-runtime');
const {
  launcherDirectory,
  registerMinecraftIpc,
  resolveGameDirectory,
  systemGameDirectory
} = require('../src/main/minecraft/ipc');

function fakeApp({ packaged = true } = {}) {
  return {
    isPackaged: packaged,
    getAppPath: () => path.resolve('project'),
    getPath(name) {
      return {
        appData: path.resolve('app-data'),
        exe: path.resolve('portable', 'launcher.exe'),
        home: path.resolve('home')
      }[name];
    }
  };
}

test('本地目录优先使用便携版启动器所在目录', () => {
  const app = fakeApp();
  const directory = launcherDirectory(app, {
    env: { PORTABLE_EXECUTABLE_DIR: path.resolve('usb', 'launcher') },
    platform: 'win32'
  });
  assert.equal(directory, path.resolve('usb', 'launcher'));
  assert.equal(
    resolveGameDirectory(app, 'local', {
      env: { PORTABLE_EXECUTABLE_DIR: path.resolve('usb', 'launcher') },
      platform: 'win32'
    }),
    path.resolve('usb', 'launcher', '.minecraft')
  );
});

test('开发环境把本地游戏目录放在项目根目录', () => {
  const app = fakeApp({ packaged: false });
  assert.equal(
    resolveGameDirectory(app, 'local', { env: {}, platform: 'win32' }),
    path.resolve('project', '.minecraft')
  );
});

test('系统目录模式保留各平台默认位置', () => {
  const app = fakeApp();
  assert.equal(systemGameDirectory(app, 'win32'), path.resolve('app-data', '.minecraft'));
  assert.equal(
    systemGameDirectory(app, 'darwin'),
    path.resolve('home', 'Library', 'Application Support', 'minecraft')
  );
  assert.equal(systemGameDirectory(app, 'linux'), path.resolve('home', '.minecraft'));
});

async function ipcFixture(t, patch = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-java-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = {
    isPackaged: false,
    getAppPath: () => root,
    getPath: (name) => path.join(root, name)
  };
  const settings = {
    gameDirectoryMode: 'system',
    downloadSource: 'auto',
    downloadConcurrency: 16,
    javaPath: '',
    ...patch
  };
  const handlers = new Map();
  const settingsStore = { getState: async () => settings };
  registerMinecraftIpc({
    app,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    shell: { trashItem: async () => {}, openPath: async () => '' },
    settingsStore
  });
  return {
    gameDirectory: systemGameDirectory(app),
    settingsStore,
    invoke: (channel, sender, ...args) => handlers.get(channel)({ sender }, ...args)
  };
}

function ipcSender(id) {
  const sender = new EventEmitter();
  sender.id = id;
  sender.messages = [];
  sender.isDestroyed = () => false;
  sender.send = (channel, progress) => sender.messages.push({ channel, progress });
  return sender;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function writeFixtureJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

test('Java 需求读取加载器继承配置并解析整合包实例', async (t) => {
  const { gameDirectory, invoke } = await ipcFixture(t);
  const sender = ipcSender(1);
  const metadataPath = (id) => path.join(gameDirectory, 'versions', id, `${id}.json`);
  await writeFixtureJson(metadataPath('base'), { id: 'base', javaVersion: { majorVersion: 17 } });
  await writeFixtureJson(metadataPath('forge'), { id: 'forge', inheritsFrom: 'base' });
  await writeFixtureJson(metadataPath('legacy'), { id: 'legacy' });
  await writeFixtureJson(path.join(gameDirectory, 'melody-instances', 'pack', '.melody-instance.json'), {
    schemaVersion: 1,
    instanceId: 'pack',
    profileId: 'forge'
  });

  assert.deepEqual(await invoke('minecraft:get-java-requirement', sender, 'forge'), { majorVersion: 17 });
  assert.deepEqual(await invoke('minecraft:get-java-requirement', sender, 'instance-pack'), { majorVersion: 17 });
  assert.deepEqual(await invoke('minecraft:get-java-requirement', sender, 'legacy'), { majorVersion: 8 });
});

test('显式 Java 下载转发版本、分段并发和独立进度频道', async (t) => {
  const { gameDirectory, invoke } = await ipcFixture(t, { downloadConcurrency: 24 });
  const sender = ipcSender(1);
  const javaPath = path.join(gameDirectory, 'runtime', 'java-21', 'bin', 'java.exe');
  const progress = { majorVersion: 21, receivedBytes: 100, totalBytes: 200 };
  t.mock.method(ManagedJavaRuntime.prototype, 'ensureInstalled', async function (majorVersion, onProgress, signal) {
    assert.equal(majorVersion, 21);
    assert.equal(this.gameDirectory, gameDirectory);
    assert.equal(this.segmentConcurrency, 12);
    assert.equal(signal.aborted, false);
    onProgress(progress);
    return javaPath;
  });

  assert.deepEqual(await invoke('minecraft:download-java', sender, 21), { javaPath, majorVersion: 21 });
  assert.deepEqual(sender.messages, [{ channel: 'minecraft:java-download-progress', progress }]);
  assert.equal(sender.listenerCount('destroyed'), 0);
});

test('设置读取期间可以立即取消 Java 下载，取消后可重试', async (t) => {
  const { invoke, settingsStore } = await ipcFixture(t);
  const owner = ipcSender(1);
  const other = ipcSender(2);
  const settingsReady = deferred();
  const readSettings = settingsStore.getState;
  let reads = 0;
  let installs = 0;
  t.mock.method(settingsStore, 'getState', async () => {
    if (++reads === 1) await settingsReady.promise;
    return readSettings();
  });
  t.mock.method(ManagedJavaRuntime.prototype, 'ensureInstalled', async (_major, _progress, signal) => {
    installs += 1;
    assert.equal(signal.aborted, false);
    return 'installed-java';
  });

  const download = invoke('minecraft:download-java', owner, 21);
  const cancelled = assert.rejects(download, /下载已取消/);
  assert.deepEqual(await invoke('minecraft:cancel-java-download', other), { cancelled: 0 });
  assert.deepEqual(await invoke('minecraft:cancel-java-download', owner), { cancelled: 1 });
  assert.equal(installs, 0);
  settingsReady.resolve();
  await cancelled;
  assert.equal(installs, 0);
  assert.equal(owner.listenerCount('destroyed'), 0);

  assert.deepEqual(await invoke('minecraft:download-java', owner, 17), {
    javaPath: 'installed-java',
    majorVersion: 17
  });
  assert.equal(installs, 1);
  assert.equal(owner.listenerCount('destroyed'), 0);
});

test('Java 取消仅影响所属窗口的 Java 任务，游戏取消保持 Java 下载', async (t) => {
  const { invoke } = await ipcFixture(t);
  const owner = ipcSender(1);
  const other = ipcSender(2);
  let javaStarted = deferred();
  let gameStarted = deferred();
  let finishJava;
  let finishGame;
  let javaSignal;
  let gameSignal;
  const pendingDownload = (signal, complete) => new Promise((resolve, reject) => {
    complete(resolve);
    signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  t.mock.method(ManagedJavaRuntime.prototype, 'ensureInstalled', async (_major, _progress, signal) => {
    javaSignal = signal;
    const pending = pendingDownload(signal, (resolve) => { finishJava = resolve; });
    javaStarted.resolve();
    return pending;
  });
  t.mock.method(MinecraftDownloader.prototype, 'installVersion', async (_version, _progress, { signal }) => {
    gameSignal = signal;
    const pending = pendingDownload(signal, (resolve) => { finishGame = resolve; });
    gameStarted.resolve();
    return pending;
  });

  const firstJava = invoke('minecraft:download-java', owner, 21);
  const firstJavaCancelled = assert.rejects(firstJava, /下载已取消/);
  const firstGame = invoke('minecraft:download-version', owner, 'base');
  await Promise.all([javaStarted.promise, gameStarted.promise]);
  assert.deepEqual(await invoke('minecraft:cancel-java-download', other), { cancelled: 0 });
  assert.equal(javaSignal.aborted, false);
  await assert.rejects(invoke('minecraft:download-java', other, 17), /正在下载中/);
  assert.deepEqual(await invoke('minecraft:cancel-java-download', owner), { cancelled: 1 });
  await firstJavaCancelled;
  assert.equal(gameSignal.aborted, false);
  finishGame({ versionId: 'base' });
  await firstGame;

  javaStarted = deferred();
  gameStarted = deferred();
  const secondJava = invoke('minecraft:download-java', owner, 17);
  const secondGame = invoke('minecraft:download-version', owner, 'base');
  const secondGameCancelled = assert.rejects(secondGame, /下载已取消/);
  await Promise.all([javaStarted.promise, gameStarted.promise]);
  assert.deepEqual(await invoke('minecraft:cancel-download', other), { cancelled: 0 });
  assert.deepEqual(await invoke('minecraft:cancel-download', owner), { cancelled: 1 });
  await secondGameCancelled;
  assert.equal(javaSignal.aborted, false);
  finishJava('installed-java');
  assert.deepEqual(await secondJava, { javaPath: 'installed-java', majorVersion: 17 });
  assert.deepEqual(await invoke('minecraft:cancel-java-download', owner), { cancelled: 0 });
  assert.equal(owner.listenerCount('destroyed'), 0);
});
