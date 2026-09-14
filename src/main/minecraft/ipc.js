const fs = require('node:fs/promises');
const path = require('node:path');
const { MinecraftDownloader } = require('./downloader');
const { MinecraftLoaderManager } = require('./loader-manager');
const { MinecraftLauncher } = require('./launch-core');
const { ModpackManager } = require('./modpack-manager');
const { MinecraftSourceManager } = require('./source-manager');
const { MinecraftVersionManager } = require('./version-manager');
const { AuthlibInjectorManager } = require('./authlib-injector');

function systemGameDirectory(app, platform = process.platform) {
  if (platform === 'win32') return path.join(app.getPath('appData'), '.minecraft');
  if (platform === 'darwin') {
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'minecraft');
  }
  return path.join(app.getPath('home'), '.minecraft');
}

function launcherDirectory(app, {
  env = process.env,
  platform = process.platform
} = {}) {
  if (env.PORTABLE_EXECUTABLE_DIR) return path.resolve(env.PORTABLE_EXECUTABLE_DIR);
  if (platform === 'linux' && env.APPIMAGE) return path.dirname(path.resolve(env.APPIMAGE));
  if (!app.isPackaged) return path.resolve(app.getAppPath());
  return path.dirname(path.resolve(app.getPath('exe')));
}

function resolveGameDirectory(app, mode, options) {
  return mode === 'system'
    ? systemGameDirectory(app, options?.platform)
    : path.join(launcherDirectory(app, options), '.minecraft');
}

function registerMinecraftIpc({
  app,
  ipcMain,
  shell,
  settingsStore,
  accountStore,
  yggdrasilAuth
}) {
  const activeDownloads = new Map();
  let gameDirectory;
  let sourceManager;
  let downloader;
  let loaderManager;
  let versionManager;
  let modpackManager;
  let launcher;
  let authlibInjector;

  async function ensureMinecraftServices(settings) {
    const currentSettings = settings ?? (settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local' });
    const requestedDirectory = resolveGameDirectory(app, currentSettings.gameDirectoryMode);
    if (gameDirectory === requestedDirectory) return currentSettings;
    if (activeDownloads.size > 0) {
      throw new Error('请先等待下载完成或取消下载，再切换游戏目录');
    }

    gameDirectory = requestedDirectory;
    sourceManager = new MinecraftSourceManager();
    downloader = new MinecraftDownloader({
      gameDirectory,
      sourceManager,
      concurrency: 32,
      segmentConcurrency: 8
    });
    loaderManager = new MinecraftLoaderManager({
      gameDirectory,
      sourceManager,
      downloader,
      concurrency: 32,
      segmentConcurrency: 8
    });
    versionManager = new MinecraftVersionManager({
      gameDirectory,
      trashItem: (targetPath) => shell.trashItem(targetPath)
    });
    modpackManager = new ModpackManager({
      gameDirectory,
      loaderManager,
      concurrency: 32,
      segmentConcurrency: 8
    });
    launcher = new MinecraftLauncher({ gameDirectory });
    authlibInjector = new AuthlibInjectorManager({ gameDirectory });
    return currentSettings;
  }

  async function applyDownloadSettings() {
    const settings = settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local', downloadConcurrency: 32, downloadSource: 'auto' };
    await ensureMinecraftServices(settings);
    const concurrency = settings.downloadConcurrency;
    sourceManager.setDownloadPreference(settings.downloadSource);
    const segmentConcurrency = Math.min(12, Math.max(4, Math.floor(concurrency / 2)));
    downloader.concurrency = concurrency;
    downloader.segmentConcurrency = segmentConcurrency;
    loaderManager.concurrency = concurrency;
    loaderManager.segmentConcurrency = segmentConcurrency;
    loaderManager.javaPath = settings.javaPath;
    modpackManager.concurrency = concurrency;
    modpackManager.segmentConcurrency = segmentConcurrency;
    return settings;
  }

  async function runDownloadTask(event, taskId, runner) {
    const registryId = `${event.sender.id}:${taskId}`;
    if (activeDownloads.has(registryId)) {
      throw new Error('该游戏版本正在下载中');
    }

    const controller = new AbortController();
    const task = { controller, senderId: event.sender.id, taskId };
    const abortWhenDestroyed = () => controller.abort();
    activeDownloads.set(registryId, task);
    event.sender.once('destroyed', abortWhenDestroyed);

    try {
      return await runner(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') {
        throw new Error('下载已取消');
      }
      throw error;
    } finally {
      event.sender.removeListener('destroyed', abortWhenDestroyed);
      activeDownloads.delete(registryId);
    }
  }

  ipcMain.handle('minecraft:list-versions', async (_event, options = {}) => {
    await applyDownloadSettings();
    return downloader.listVersions({ force: options.force === true });
  });

  ipcMain.handle('minecraft:list-local-versions', async () => {
    await ensureMinecraftServices();
    return versionManager.listLocalProfiles();
  });

  ipcMain.handle('minecraft:inspect-modpack', async (_event, filePath) => {
    await ensureMinecraftServices();
    return modpackManager.inspect(filePath);
  });

  ipcMain.handle('minecraft:install-modpack', async (event, filePath) => {
    await applyDownloadSettings();
    return runDownloadTask(event, `modpack:${path.basename(String(filePath ?? ''))}`, (signal) => (
      modpackManager.install(filePath, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('minecraft:download-progress', progress);
        }
      }, { signal, installOptionalFiles: options.installOptionalFiles === true })
    ));
  });

  ipcMain.handle('minecraft:download-version', async (event, versionId) => {
    await applyDownloadSettings();
    return runDownloadTask(event, `vanilla:${versionId}`, (signal) => (
      downloader.installVersion(versionId, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('minecraft:download-progress', progress);
        }
      }, { signal })
    ));
  });

  ipcMain.handle('minecraft:list-loaders', async (_event, request = {}) => {
    await applyDownloadSettings();
    return loaderManager.listLoaderVersions(
      request.gameVersion,
      request.loaderType,
      { force: request.force === true }
    );
  });

  ipcMain.handle('minecraft:install-loader', async (event, request = {}) => {
    await applyDownloadSettings();
    const taskId = `${request.gameVersion}:${request.loaderType}:${request.loaderVersion ?? ''}`;
    return runDownloadTask(event, taskId, (signal) => (
      loaderManager.installLoader(request, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('minecraft:download-progress', progress);
        }
      }, { signal })
    ));
  });

  ipcMain.handle('minecraft:cancel-download', async (event) => {
    let cancelled = 0;
    for (const task of activeDownloads.values()) {
      if (task.senderId === event.sender.id && !task.controller.signal.aborted) {
        task.controller.abort();
        cancelled += 1;
      }
    }
    return { cancelled };
  });

  ipcMain.handle('minecraft:verify-version', async (event, versionId) => {
    if (activeDownloads.size > 0) {
      throw new Error('请先等待下载完成或取消下载，再检测游戏文件');
    }
    await applyDownloadSettings();
    return downloader.verifyVersion(versionId, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('minecraft:verify-progress', progress);
      }
    });
  });

  ipcMain.handle('minecraft:delete-version', async (_event, profileId) => {
    if (activeDownloads.size > 0) {
      throw new Error('请先等待下载完成或取消下载，再删除游戏版本');
    }
    await ensureMinecraftServices();
    return versionManager.deleteProfile(profileId);
  });

  ipcMain.handle('minecraft:launch-version', async (event, profileId) => {
    if (activeDownloads.size > 0) {
      throw new Error('请先等待下载完成或取消下载，再启动游戏');
    }
    let currentAccount = accountStore ? await accountStore.getCurrentAccount() : undefined;
    if (currentAccount?.type === 'yggdrasil' && yggdrasilAuth) {
      currentAccount = await yggdrasilAuth.ensureAccount(currentAccount);
    }
    const settings = settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local', memoryMb: 4096 };
    await ensureMinecraftServices(settings);
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('minecraft:launch-status', status);
    };
    try {
      const requestedTargetId = String(profileId ?? '');
      const instance = await modpackManager.resolveLaunchTarget(requestedTargetId);
      const authlibInjectorPath = currentAccount?.type === 'yggdrasil'
        ? await authlibInjector.ensureInstalled((progress) => sendStatus({
            phase: 'authlib-injector',
            profileId: instance?.profileId ?? requestedTargetId,
            targetId: requestedTargetId,
            ...progress
          }))
        : undefined;
      return await launcher.launch({
        profileId: instance?.profileId ?? requestedTargetId,
        targetId: requestedTargetId,
        instanceDirectory: instance?.instanceDirectory,
        account: currentAccount,
        memoryMb: settings.memoryMb,
        javaPath: settings.javaPath,
        authlibInjector: authlibInjectorPath
          ? { path: authlibInjectorPath, server: 'littleskin.cn' }
          : undefined
      }, sendStatus);
    } catch (error) {
      sendStatus({
        phase: 'failed',
        profileId: String(profileId ?? ''),
        targetId: String(profileId ?? ''),
        message: error.message
      });
      throw error;
    }
  });

  ipcMain.handle('minecraft:open-directory', async () => {
    await ensureMinecraftServices();
    await fs.mkdir(gameDirectory, { recursive: true });
    const error = await shell.openPath(gameDirectory);
    if (error) {
      throw new Error(error);
    }
    return gameDirectory;
  });
}

module.exports = {
  launcherDirectory,
  registerMinecraftIpc,
  resolveGameDirectory,
  systemGameDirectory
};
