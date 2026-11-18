const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { resolveGameDirectory } = require('./minecraft/ipc');

const REQUIRED_STARTUP_RESOURCES = Object.freeze([
  'package.json',
  'src/preload/preload.js',
  'src/renderer/index.html',
  'src/renderer/styles.css',
  'src/renderer/renderer.js',
  'src/renderer/modules/account-ui.mjs',
  'src/renderer/modules/modpack-ui.mjs',
  'src/renderer/modules/launcher-update-ui.mjs',
  'src/renderer/modules/fabric-api-ui.mjs',
  'src/renderer/assets/app-icon.ico',
  'src/renderer/assets/app-icon.png',
  'src/renderer/assets/app-icon.icns',
  'src/renderer/assets/backgrounds/wp15225187.jpg',
  'src/renderer/assets/backgrounds/wp15225191.jpg',
  'src/renderer/assets/backgrounds/NjGW245.jpg',
  'src/renderer/assets/backgrounds/640c286f00c515f0fe1c0bc0415bae64~tplv-a9rns2rl98-pc_smart_face_crop-v1_512_384.jpg',
  'src/main/accounts/microsoft-client-id.json',
  'src/shared/task-errors.js',
  'src/shared/build-info.js',
  'src/shared/release-metadata.js',
  'src/shared/website-cdn-config.json'
]);

const GAME_DIRECTORIES = Object.freeze([
  'versions', 'libraries', 'assets/indexes', 'assets/objects',
  'melody-instances', 'runtime/melody', 'launcher-cache'
]);

async function ensureStoredDefaults(store) {
  // Use the store's recovery and write queue so a missing primary restores its
  // backup, and concurrent account/settings changes cannot be overwritten.
  return store.storage.runExclusive(async () => {
    const state = await store.read();
    const primary = await store.storage.snapshot(store.filePath);
    if (primary.missing) await store.write(state);
    else if ((await store.storage.snapshot(store.storage.backupPath)).missing) {
      // Preserve serialized account secrets and original formatting verbatim.
      await store.storage.atomicWrite(store.storage.backupPath, primary.bytes, primary.mode);
    }
    return state;
  });
}

function createStartupPreparation({ app, getSettingsStore, getAccountStore,
  onProgress, fileSystem = fs, gameDirectoryOptions } = {}) {
  let pending;
  let latestProgress;
  const listeners = new Set();

  function send(listener, state) {
    try { listener?.(state); } catch { /* A closed window must not interrupt disk preparation. */ }
  }

  function report(phase, message, progress) {
    latestProgress = { phase, message, progress };
    send(onProgress, latestProgress);
    for (const listener of listeners) send(listener, latestProgress);
  }

  async function run() {
    report('checking-resources', '正在检查启动器文件…', 10);
    const root = app.getAppPath();
    for (const resource of REQUIRED_STARTUP_RESOURCES) {
      const filename = path.join(root, resource);
      try {
        const stat = await fileSystem.stat(filename);
        if (!stat.isFile() || stat.size === 0) {
          throw Object.assign(new Error('文件为空或不是普通文件'), { code: 'INVALID_RESOURCE' });
        }
        await fileSystem.access(filename, constants.R_OK);
      } catch (cause) {
        throw Object.assign(new Error(`启动器文件缺失或无法读取：${resource}。请重新下载完整启动器后重试。`, { cause }), {
          code: 'STARTUP_RESOURCE_MISSING', resource
        });
      }
    }

    report('preparing-config', '正在准备账户与启动器设置…', 40);
    const settings = await ensureStoredDefaults(getSettingsStore());
    await ensureStoredDefaults(getAccountStore());

    report('preparing-directories', '正在准备游戏与日志目录…', 70);
    const gameDirectory = resolveGameDirectory(app, settings.gameDirectoryMode, gameDirectoryOptions);
    const logsDirectory = path.join(app.getPath('userData'), 'logs');
    await fileSystem.mkdir(logsDirectory, { recursive: true });
    await fileSystem.access(logsDirectory, constants.W_OK);
    try {
      for (const name of GAME_DIRECTORIES) {
        const directory = path.join(gameDirectory, name);
        await fileSystem.mkdir(directory, { recursive: true });
        await fileSystem.access(directory, constants.W_OK);
      }
    } catch (error) {
      throw Object.assign(error, { phase: 'preparing-directories',
        details: { gameDirectoryMode: settings.gameDirectoryMode, gameDirectory } });
    }
    report('ready', '启动器准备完成', 100);
    return { ready: true, gameDirectory };
  }

  function prepare(listener) {
    if (typeof listener === 'function') {
      listeners.add(listener);
      if (pending && latestProgress) send(listener, latestProgress);
    }
    if (!pending) {
      latestProgress = undefined;
      // Defer work until pending is assigned, including callbacks that retry.
      pending = Promise.resolve().then(run).finally(() => {
        pending = undefined;
        listeners.clear();
      });
    }
    return pending;
  }

  return { prepare };
}

module.exports = { createStartupPreparation, REQUIRED_STARTUP_RESOURCES, GAME_DIRECTORIES };
