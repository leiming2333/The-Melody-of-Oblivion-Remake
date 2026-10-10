const fs = require('node:fs/promises');
const path = require('node:path');
const { createLazyServices } = require('../lazy-services');

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
  if (platform === 'darwin') {
    return path.resolve(path.dirname(app.getPath('exe')), '..', '..', '..');
  }
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
  dialog,
  BrowserWindow,
  settingsStore,
  accountStore,
  microsoftAuth,
  yggdrasilAuth,
  javaProbeCache,
  getSettingsStore = () => settingsStore,
  getAccountStore = () => accountStore,
  getMicrosoftAuth = () => microsoftAuth,
  getYggdrasilAuth = () => yggdrasilAuth,
  getJavaProbeCache = () => javaProbeCache
}) {
  const activeDownloads = new Map();
  const preparingJavaDownloads = new Map();
  let gameDirectory;
  let services;
  let serviceSettings;

  async function ensureMinecraftServices(settings) {
    const settingsStore = getSettingsStore();
    const currentSettings = settings ?? (settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local' });
    const requestedDirectory = resolveGameDirectory(app, currentSettings.gameDirectoryMode);
    if (gameDirectory === requestedDirectory) return currentSettings;
    if (activeDownloads.size > 0) {
      throw new Error('请先等待下载完成或取消下载，再切换游戏目录');
    }

    gameDirectory = requestedDirectory;
    serviceSettings = { ...currentSettings };
    const config = serviceSettings;
    const directory = requestedDirectory;
    const transferOptions = () => ({ gameDirectory: directory,
      concurrency: config.downloadConcurrency ?? 32,
      segmentConcurrency: Math.min(12, Math.max(4, Math.floor((config.downloadConcurrency ?? 32) / 2))) });
    services = createLazyServices({
      sourceManager: () => {
        const { MinecraftSourceManager } = require('./source-manager');
        const manager = new MinecraftSourceManager();
        manager.setDownloadPreference(config.downloadSource ?? 'auto');
        return manager;
      },
      downloader: (registry) => {
        const { MinecraftDownloader } = require('./downloader');
        return new MinecraftDownloader({ ...transferOptions(), sourceManager: registry.sourceManager });
      },
      loaderManager: (registry) => {
        const { MinecraftLoaderManager } = require('./loader-manager');
        const manager = new MinecraftLoaderManager({ ...transferOptions(),
          sourceManager: registry.sourceManager, downloader: registry.downloader });
        manager.javaPath = config.javaPath;
        return manager;
      },
      versionManager: () => {
        const { MinecraftVersionManager } = require('./version-manager');
        return new MinecraftVersionManager({ gameDirectory: directory, trashItem: (target) => shell.trashItem(target) });
      },
      modpackManager: (registry) => {
        const { ModpackManager } = require('./modpack-manager');
        const manager = new ModpackManager(transferOptions());
        Object.defineProperty(manager, 'loaderManager', { get: () => registry.loaderManager });
        return manager;
      },
      javaRuntime: () => {
        const { ManagedJavaRuntime } = require('./managed-java-runtime');
        const { javaMajorVersion } = require('./java-runtime');
        const javaProbeCache = getJavaProbeCache();
        return new ManagedJavaRuntime({ gameDirectory: directory,
          extractArchive: (...args) => require('./launch-core').extractArchive(...args),
          probeJava: javaProbeCache ? (candidate) => javaProbeCache.probe(candidate) : javaMajorVersion });
      },
      launcher: (registry) => {
        const { MinecraftLauncher } = require('./launch-core');
        const launcher = new MinecraftLauncher({ gameDirectory: directory, javaRuntime: registry.javaRuntime });
        return launcher;
      },
      authlibInjector: () => {
        const { AuthlibInjectorManager } = require('./authlib-injector');
        return new AuthlibInjectorManager({ gameDirectory: directory });
      }
    });
    return currentSettings;
  }

  async function applyDownloadSettings() {
    const settingsStore = getSettingsStore();
    const settings = settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local', downloadConcurrency: 32, downloadSource: 'auto' };
    await ensureMinecraftServices(settings);
    Object.assign(serviceSettings, settings);
    const sourceManager = services.peek('sourceManager');
    sourceManager?.setDownloadPreference(settings.downloadSource);
    const concurrency = settings.downloadConcurrency;
    const segmentConcurrency = Math.min(12, Math.max(4, Math.floor(concurrency / 2)));
    for (const name of ['downloader', 'loaderManager', 'modpackManager']) {
      const manager = services.peek(name);
      if (manager) Object.assign(manager, { concurrency, segmentConcurrency });
    }
    const loaderManager = services.peek('loaderManager');
    if (loaderManager) loaderManager.javaPath = settings.javaPath;
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
    return services.downloader.listVersions({ force: options.force === true });
  });

  ipcMain.handle('minecraft:list-local-versions', async () => {
    await ensureMinecraftServices();
    return services.versionManager.listLocalProfiles();
  });

  ipcMain.handle('minecraft:get-java-requirement', async (_event, targetId) => {
    const { resolveLaunchTarget } = require('./launch-target');
    const { readVersionMetadata } = require('./version-metadata');
    await ensureMinecraftServices();
    const instance = await resolveLaunchTarget(gameDirectory, String(targetId ?? ''));
    const metadata = await readVersionMetadata(gameDirectory, instance?.profileId ?? targetId);
    return { majorVersion: metadata.javaVersion?.majorVersion ?? 8 };
  });

  ipcMain.handle('minecraft:detect-java', async (_event, options = {}) => {
    const { detectJava, javaMajorVersion, installedJavaExecutable, SUPPORTED_JAVA_MAJORS } = require('./java-runtime');
    const javaProbeCache = getJavaProbeCache();
    const settings = await ensureMinecraftServices();
    const probe = javaProbeCache
      ? (candidate) => javaProbeCache.probe(candidate, { force: options.force === true })
      : javaMajorVersion;
    const results = await Promise.allSettled([
      detectJava(settings.javaPath, probe, undefined, { launcherDirectory: launcherDirectory(app) }),
      ...SUPPORTED_JAVA_MAJORS.map(async (majorVersion) => {
      const javaPath = await installedJavaExecutable(gameDirectory, majorVersion, javaProbeCache
        ? (candidate) => javaProbeCache.probe(candidate, { force: options.force === true })
        : javaMajorVersion);
      if (!javaPath) return null;
      return { available: true, path: javaPath, majorVersion };
      })
    ]);
    const candidates = results.filter((result) => result.status === 'fulfilled' && result.value?.available)
      .map((result) => result.value);
    candidates.sort((left, right) => right.majorVersion - left.majorVersion);
    return candidates[0]
      ? { ...candidates[0], runtimes: candidates.flatMap((entry) => entry.runtimes ?? [{ path: entry.path, majorVersion: entry.majorVersion }]) }
      : { available: false };
  });

  ipcMain.handle('minecraft:download-java', async (event, majorVersion) => {
    if (preparingJavaDownloads.size > 0
        || [...activeDownloads.values()].some((task) => task.taskId === 'java-runtime')) {
      throw new Error('Java 运行环境正在下载中');
    }
    const controller = new AbortController();
    const abortWhenDestroyed = () => controller.abort();
    preparingJavaDownloads.set(event.sender.id, controller);
    event.sender.once('destroyed', abortWhenDestroyed);
    try {
      const settings = await applyDownloadSettings();
      if (controller.signal.aborted || event.sender.isDestroyed()) throw new Error('下载已取消');
      const runtime = services.javaRuntime;
      runtime.segmentConcurrency = Math.min(12, Math.max(4, Math.floor(settings.downloadConcurrency / 2)));
      return await runDownloadTask(event, 'java-runtime', async (signal) => {
        const javaPath = await runtime.ensureInstalled(majorVersion, (progress) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send('minecraft:java-download-progress', progress);
          }
        }, AbortSignal.any([signal, controller.signal]));
        return { javaPath, majorVersion };
      });
    } finally {
      preparingJavaDownloads.delete(event.sender.id);
      event.sender.removeListener('destroyed', abortWhenDestroyed);
    }
  });

  ipcMain.handle('minecraft:cancel-java-download', async (event) => {
    const task = activeDownloads.get(`${event.sender.id}:java-runtime`);
    const controller = task?.controller ?? preparingJavaDownloads.get(event.sender.id);
    if (!controller || controller.signal.aborted) return { cancelled: 0 };
    controller.abort();
    return { cancelled: 1 };
  });

  ipcMain.handle('minecraft:inspect-modpack', async (_event, filePath) => {
    await ensureMinecraftServices();
    return services.modpackManager.inspect(filePath);
  });

  ipcMain.handle('minecraft:install-modpack', async (event, filePath, options = {}) => {
    await applyDownloadSettings();
    return runDownloadTask(event, `modpack:${path.basename(String(filePath ?? ''))}`, (signal) => (
      services.modpackManager.install(filePath, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('minecraft:download-progress', progress);
        }
      }, { signal, installOptionalFiles: options.installOptionalFiles === true })
    ));
  });

  ipcMain.handle('minecraft:download-version', async (event, versionId) => {
    await applyDownloadSettings();
    return runDownloadTask(event, `vanilla:${versionId}`, (signal) => (
      services.downloader.installVersion(versionId, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('minecraft:download-progress', progress);
        }
      }, { signal })
    ));
  });

  ipcMain.handle('minecraft:list-loaders', async (_event, request = {}) => {
    await applyDownloadSettings();
    return services.loaderManager.listLoaderVersions(
      request.gameVersion,
      request.loaderType,
      { force: request.force === true }
    );
  });

  ipcMain.handle('minecraft:install-loader', async (event, request = {}) => {
    await applyDownloadSettings();
    const taskId = `${request.gameVersion}:${request.loaderType}:${request.loaderVersion ?? ''}`;
    return runDownloadTask(event, taskId, (signal) => (
      services.loaderManager.installLoader(request, (progress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('minecraft:download-progress', progress);
        }
      }, { signal })
    ));
  });

  ipcMain.handle('minecraft:cancel-download', async (event) => {
    let cancelled = 0;
    for (const task of activeDownloads.values()) {
      if (task.senderId === event.sender.id && task.taskId !== 'java-runtime'
          && !task.controller.signal.aborted) {
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
    return services.downloader.verifyVersion(versionId, (progress) => {
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
    return services.versionManager.deleteProfile(profileId);
  });

  ipcMain.handle('minecraft:launch-version', async (event, profileId) => {
    if (activeDownloads.size > 0) {
      throw new Error('请先等待下载完成或取消下载，再启动游戏');
    }
    const accountStore = getAccountStore();
    const settingsStore = getSettingsStore();
    let currentAccount = accountStore ? await accountStore.getCurrentAccount() : undefined;
    if (currentAccount?.type === 'microsoft') {
      const auth = getMicrosoftAuth();
      if (!auth) throw new Error('Microsoft 登录服务不可用，请重新登录');
      try {
        currentAccount = await auth.ensureAccount(currentAccount);
      } catch (error) {
        if (error.code !== 'MICROSOFT_AUTH_EXPIRED') throw error;
        await accountStore.signOut(currentAccount.id);
        throw new Error('Microsoft 登录已过期，已自动退出，请重新登录');
      }
    }
    if (currentAccount?.type === 'yggdrasil') {
      const yggdrasilAuth = getYggdrasilAuth();
      if (yggdrasilAuth) currentAccount = await yggdrasilAuth.ensureAccount(currentAccount);
    }
    const settings = settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local', memoryMb: 4096 };
    await ensureMinecraftServices(settings);
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('minecraft:launch-status', status);
    };
    try {
      const { resolveLaunchTarget, profileGameDirectory } = require('./launch-target');
      const requestedTargetId = String(profileId ?? '');
      const instance = await resolveLaunchTarget(gameDirectory, requestedTargetId);
      const authlibInjectorPath = currentAccount?.type === 'yggdrasil'
        ? await services.authlibInjector.ensureInstalled((progress) => sendStatus({
            phase: 'authlib-injector',
            profileId: instance?.profileId ?? requestedTargetId,
            targetId: requestedTargetId,
            ...progress
          }))
        : undefined;
      return await services.launcher.launch({
        profileId: instance?.profileId ?? requestedTargetId,
        targetId: requestedTargetId,
        instanceDirectory: instance?.instanceDirectory ?? (settings.isolateProfiles !== false
          ? profileGameDirectory(gameDirectory, requestedTargetId) : undefined),
        account: currentAccount,
        memoryMb: settings.memoryMb,
        javaPath: settings.javaPath,
        javaRuntimes: settings.javaRuntimes ?? [],
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

  let modManager;
  const getModManager = () => modManager ??= new (require('./mod-manager').ModManager)();
  async function targetDirectory(targetId, mutate = false) {
    const settings = await ensureMinecraftServices();
    if (mutate && (activeDownloads.size || services.peek('launcher')?.activeGames?.size)) {
      throw new Error('请先关闭游戏并等待安装完成，再修改 Mod');
    }
    const root = gameDirectory;
    const { resolveLaunchTarget, profileGameDirectory } = require('./launch-target');
    const instance = await resolveLaunchTarget(root, targetId);
    await require('./version-metadata').readVersionMetadata(root, instance?.profileId ?? targetId);
    const directory = instance?.instanceDirectory ?? (settings.isolateProfiles !== false
      ? profileGameDirectory(root, targetId) : root);
    // Reject redirected parents beneath the game root.
    const relative = path.relative(root, directory);
    let parent = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      parent = path.join(parent, segment);
      try { if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('实例目录不能是链接'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return directory;
  }
  ipcMain.handle('minecraft:list-mods', async (_event, targetId) => getModManager().list(await targetDirectory(targetId)));
  ipcMain.handle('minecraft:set-mod-enabled', async (_event, targetId, name, enabled) => (
    getModManager().setEnabled(await targetDirectory(targetId, true), name, enabled)
  ));
  ipcMain.handle('minecraft:import-mod-file', async (_event, targetId, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.jar$/i.test(filePath)) {
      throw new Error('请拖入有效的 .jar Mod 文件');
    }
    return getModManager().importFile(await targetDirectory(targetId, true), filePath);
  });
  ipcMain.handle('minecraft:import-mod', async (event, targetId) => {
    if (!dialog) throw new Error('文件选择服务不可用');
    const selection = await dialog.showOpenDialog(BrowserWindow?.fromWebContents(event.sender), {
      title: '导入当前实例的 Mod', properties: ['openFile'], filters: [{ name: 'Java Mod', extensions: ['jar'] }]
    });
    if (selection.canceled || !selection.filePaths.length) return { canceled: true };
    const mods = await getModManager().importFile(await targetDirectory(targetId, true), selection.filePaths[0]);
    return { canceled: false, mods };
  });

  ipcMain.handle('minecraft:open-directory', async (_event, targetId) => {
    await ensureMinecraftServices();
    const directory = targetId ? await targetDirectory(targetId) : gameDirectory;
    await fs.mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) {
      throw new Error(error);
    }
    return directory;
  });
}

module.exports = {
  launcherDirectory,
  registerMinecraftIpc,
  resolveGameDirectory,
  systemGameDirectory
};
