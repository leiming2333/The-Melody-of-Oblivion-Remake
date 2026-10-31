const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createLazyServices } = require('../lazy-services');
const { createTaskError, registerTaskHandler } = require('../../shared/task-errors');

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
  const gameProcesses = new (require('./game-process-registry').GameProcessRegistry)();
  let gameDirectory;
  let services;
  let serviceSettings;

  async function ensureMinecraftServices(settings, preparingTask, onBound) {
    const settingsStore = getSettingsStore();
    const currentSettings = settings ?? (settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local' });
    const requestedDirectory = resolveGameDirectory(app, currentSettings.gameDirectoryMode);
    if (preparingTask?.controller.signal.aborted) throw createTaskError('TASK_CANCELLED', '下载已取消');
    if (gameDirectory === requestedDirectory) {
      if (preparingTask) Object.assign(preparingTask, { directory: gameDirectory, preparing: false });
      onBound?.({ directory: gameDirectory, services });
      return currentSettings;
    }
    if ([...activeDownloads.values()].some((task) => task !== preparingTask && !task.preparing)) {
      throw new Error('请先等待下载完成或取消下载，再切换游戏目录');
    }

    const oldManager = services?.peek('modpackManager');
    for (const [ownerId, entry] of recoveryOwners) {
      oldManager?.releaseOwnerSessions?.(ownerId);
      entry.sender.removeListener('destroyed', entry.listener);
    }
    recoveryOwners.clear();
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
      fabricApiManager: () => {
        const { FabricApiManager } = require('./fabric-api-manager');
        return new FabricApiManager(transferOptions());
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
        const launcher = new MinecraftLauncher({ gameDirectory: directory, javaRuntime: registry.javaRuntime,
          activeGames: gameProcesses.forDirectory(directory),
          verifyFiles: (profileId, onProgress) => registry.downloader.verifyVersion(profileId, onProgress) });
        return launcher;
      },
      authlibInjector: () => {
        const { AuthlibInjectorManager } = require('./authlib-injector');
        return new AuthlibInjectorManager({ gameDirectory: directory });
      }
    });
    if (preparingTask) Object.assign(preparingTask, { directory: gameDirectory, preparing: false });
    onBound?.({ directory: gameDirectory, services });
    return currentSettings;
  }

  async function applyDownloadSettings(task) {
    const settingsStore = getSettingsStore();
    const settings = settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local', downloadConcurrency: 32, downloadSource: 'auto' };
    await ensureMinecraftServices(settings, task);
    if (task) {
      task.directory = gameDirectory;
      task.preparing = false;
      if (task.controller.signal.aborted) throw createTaskError('TASK_CANCELLED', '下载已取消');
    }
    Object.assign(serviceSettings, settings);
    const sourceManager = services.peek('sourceManager');
    sourceManager?.setDownloadPreference(settings.downloadSource);
    const concurrency = settings.downloadConcurrency;
    const segmentConcurrency = Math.min(12, Math.max(4, Math.floor(concurrency / 2)));
    for (const name of ['downloader', 'loaderManager', 'modpackManager', 'fabricApiManager']) {
      const manager = services.peek(name);
      if (manager) Object.assign(manager, { concurrency, segmentConcurrency });
    }
    const loaderManager = services.peek('loaderManager');
    if (loaderManager) loaderManager.javaPath = settings.javaPath;
    return settings;
  }

  const recoveryOwners = new Map();
  function recoveryOutcome(sender, result) {
    const old = recoveryOwners.get(sender.id);
    if (result?.status === 'waiting-for-files' && !old) {
      const manager = services?.peek('modpackManager');
      const listener = () => {
        manager?.releaseOwnerSessions?.(sender.id);
        recoveryOwners.delete(sender.id);
      };
      sender.once('destroyed', listener);
      recoveryOwners.set(sender.id, { sender, listener });
    } else if (result?.status !== 'waiting-for-files' && old) {
      sender.removeListener('destroyed', old.listener);
      recoveryOwners.delete(sender.id);
    }
    return result;
  }
  async function runDownloadTask(event, kind, runner, options = {}) {
    const taskId = typeof options.taskId === 'string' && /^[\w-]{1,100}$/.test(options.taskId)
      ? options.taskId : randomUUID();
    const registryId = `${event.sender.id}:${kind}:${taskId}`;
    const javaTask = kind === 'java-runtime';
    if ([...activeDownloads.values()].some((task) => javaTask
      ? task.kind === 'java-runtime' : task.kind !== 'java-runtime')) {
      throw createTaskError('TASK_BUSY', javaTask ? 'Java 运行环境正在下载中' : '请先等待当前安装完成或取消');
    }
    const controller = new AbortController();
    const task = { controller, senderId: event.sender.id, taskId, kind, preparing: true, cancellable: true };
    const abortWhenDestroyed = () => {
      controller.abort();
      services?.peek('modpackManager')?.releaseOwnerSessions?.(event.sender.id);
      recoveryOwners.delete(event.sender.id);
    };
    activeDownloads.set(registryId, task);
    event.sender.once('destroyed', abortWhenDestroyed);
    const report = (progress) => {
      task.phase = progress.phase;
      if (progress.cancellable === false) task.cancellable = false;
      if (!event.sender.isDestroyed()) event.sender.send(javaTask
        ? 'minecraft:java-download-progress' : 'minecraft:download-progress', {
        ...progress, taskId, cancellable: task.cancellable
      });
    };
    try {
      report({ phase: 'preparing', message: '正在准备任务…' });
      return await runner(controller.signal, report, task);
    } catch (error) {
      if (controller.signal.aborted || error.name === 'AbortError') {
        throw createTaskError('TASK_CANCELLED', '下载已取消', { phase: task.phase });
      }
      if (!error.phase) error.phase = task.phase;
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

  registerTaskHandler(ipcMain, 'minecraft:download-java', (event, majorVersion, options = {}) => (
    runDownloadTask(event, 'java-runtime', async (signal, report, task) => {
      const settings = await applyDownloadSettings(task);
      const runtime = services.javaRuntime;
      runtime.segmentConcurrency = Math.min(12, Math.max(4, Math.floor(settings.downloadConcurrency / 2)));
      const javaPath = await runtime.ensureInstalled(majorVersion, report, signal);
      return { javaPath, majorVersion };
    }, options)
  ));

  ipcMain.handle('minecraft:cancel-java-download', async (event) => {
    const task = [...activeDownloads.values()].find((entry) => entry.senderId === event.sender.id
      && entry.kind === 'java-runtime');
    const controller = task?.controller;
    if (!controller || controller.signal.aborted) return { cancelled: 0 };
    controller.abort();
    return { cancelled: 1 };
  });

  registerTaskHandler(ipcMain, 'minecraft:inspect-modpack', (event, filePath, options = {}) => (
    runDownloadTask(event, 'inspect-modpack', async (signal, _report, task) => {
      await applyDownloadSettings(task);
      return services.modpackManager.inspect(filePath, { signal });
    }, options)
  ));

  registerTaskHandler(ipcMain, 'minecraft:get-modpack-recovery', async (event) => {
    await applyDownloadSettings();
    const result = await services.modpackManager.claimRecoverySession(event.sender.id);
    return recoveryOutcome(event.sender, result);
  });

  registerTaskHandler(ipcMain, 'minecraft:install-modpack', (event, filePath, options = {}) => (
    runDownloadTask(event, 'modpack', async (signal, report, task) => {
      await applyDownloadSettings(task);
      const manager = services.modpackManager;
      await manager.discardOwnerSessions?.(event.sender.id);
      const result = await manager.install(filePath, report, {
        signal, installOptionalFiles: options.installOptionalFiles === true, ownerId: event.sender.id
      });
      return recoveryOutcome(event.sender, result);
    }, options)
  ));

  registerTaskHandler(ipcMain, 'minecraft:resume-modpack', (event, sessionId, options = {}) => (
    runDownloadTask(event, 'modpack', async (signal, report, task) => {
      await applyDownloadSettings(task);
      const result = await services.modpackManager.resume(sessionId, report, { signal, ownerId: event.sender.id });
      return recoveryOutcome(event.sender, result);
    }, options)
  ));

  registerTaskHandler(ipcMain, 'minecraft:select-missing-modpack-file', (event, sessionId, identity, options = {}) => (
    runDownloadTask(event, 'modpack-file', async (signal, _report, task) => {
      await applyDownloadSettings(task);
      const manager = services.modpackManager;
      await manager.getRecoveryState(sessionId, { ownerId: event.sender.id });
      if (!dialog) throw new Error('文件选择服务不可用');
      const selection = await dialog.showOpenDialog(BrowserWindow?.fromWebContents?.(event.sender), {
        title: '选择下载的整合包文件', properties: ['openFile'],
        filters: [{ name: '整合包文件', extensions: ['jar', 'zip'] }, { name: '所有文件', extensions: ['*'] }]
      });
      if (signal.aborted) throw createTaskError('TASK_CANCELLED', '下载已取消');
      if (selection.canceled || !selection.filePaths.length) return { canceled: true };
      return manager.importMissingFile(sessionId, {
        projectId: identity?.projectId, fileId: identity?.fileId, filePath: selection.filePaths[0]
      }, { signal, ownerId: event.sender.id });
    }, options)
  ));

  registerTaskHandler(ipcMain, 'minecraft:discard-modpack-session', async (event, sessionId) => {
    await ensureMinecraftServices();
    const result = await services.modpackManager.discardSession(sessionId, { ownerId: event.sender.id });
    recoveryOutcome(event.sender, null);
    return result;
  });

  registerTaskHandler(ipcMain, 'minecraft:download-version', (event, versionId, options = {}) => (
    runDownloadTask(event, 'vanilla', async (signal, report, task) => {
      await applyDownloadSettings(task);
      return services.downloader.installVersion(versionId, report, { signal });
    }, options)
  ));

  ipcMain.handle('minecraft:list-loaders', async (_event, request = {}) => {
    await applyDownloadSettings();
    return services.loaderManager.listLoaderVersions(
      request.gameVersion,
      request.loaderType,
      { force: request.force === true }
    );
  });

  let fabricApiCatalog;
  registerTaskHandler(ipcMain, 'minecraft:list-fabric-api-versions', (_event, gameVersion, options = {}) => {
    const { FabricApiManager } = require('./fabric-api-manager');
    fabricApiCatalog ??= new FabricApiManager({});
    return fabricApiCatalog.listVersions(gameVersion, { force: options.force === true });
  });

  registerTaskHandler(ipcMain, 'minecraft:install-loader', (event, request = {}) => (
    runDownloadTask(event, 'loader', async (signal, report, task) => {
      const withFabricApi = request.fabricApiVersionId != null;
      if (withFabricApi && request.loaderType !== 'fabric') {
        throw createTaskError('FABRIC_API_INCOMPATIBLE', 'Fabric API 只能随 Fabric 加载器安装');
      }
      const settings = await applyDownloadSettings(task);
      const directory = gameDirectory;
      const selectedServices = services;
      const directoryKey = (value) => process.platform === 'win32'
        ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (request.expectedGameDirectory && (typeof request.expectedGameDirectory !== 'string'
          || directoryKey(request.expectedGameDirectory) !== directoryKey(directory))) {
        throw createTaskError('GAME_DIRECTORY_CHANGED', '游戏目录已改变，请重新选择版本后安装');
      }
      if (withFabricApi) {
        if (gameProcesses.isBusy(directory)) {
          throw createTaskError('GAME_RUNNING', '请先关闭当前目录中运行的游戏，再安装 Fabric API');
        }
        report({ phase: 'preparing', message: '正在核对 Fabric API 版本兼容性…' });
        await selectedServices.fabricApiManager.resolveVersion(request.gameVersion, request.fabricApiVersionId, { signal });
        if (signal.aborted) throw createTaskError('TASK_CANCELLED', '下载已取消');
      }
      const result = await selectedServices.loaderManager.installLoader(request, (progress) => report({
        ...progress, phase: withFabricApi && progress.phase === 'complete' ? 'loader-ready' : progress.phase
      }), { signal });
      if (!withFabricApi) return result;
      if (signal.aborted) throw createTaskError('TASK_CANCELLED', '下载已取消');
      const { profileGameDirectory } = require('./launch-target');
      const instanceDirectory = settings.isolateProfiles !== false
        ? profileGameDirectory(directory, result.profileId) : directory;
      const fabricApi = await selectedServices.fabricApiManager.installVersion({
        gameVersion: request.gameVersion, versionId: request.fabricApiVersionId, instanceDirectory
      }, report, { signal });
      report({ phase: 'complete', message: 'Fabric 和 Fabric API 安装完成',
        profileId: result.profileId, gameDirectory: directory });
      return { ...result, fabricApi };
    }, request)
  ));

  ipcMain.handle('minecraft:cancel-download', async (event, options = {}) => {
    let cancelled = 0;
    let committing = false;
    for (const task of activeDownloads.values()) {
      if (task.senderId === event.sender.id && task.kind !== 'java-runtime'
          && (!options.taskId || task.taskId === options.taskId)
          && !task.controller.signal.aborted) {
        if (!task.cancellable) { committing = true; continue; }
        task.controller.abort();
        cancelled += 1;
      }
    }
    return committing ? { cancelled, committing: true } : { cancelled };
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

  registerTaskHandler(ipcMain, 'minecraft:repair-version', (event, targetId, options = {}) => (
    runDownloadTask(event, 'repair-version', async (signal, report, task) => {
      await applyDownloadSettings(task);
      const directory = gameDirectory;
      const downloader = services.downloader;
      if (gameProcesses.isBusy(directory)) throw new Error('请先关闭当前目录中运行的游戏，再补全游戏文件');
      const { resolveLaunchTarget } = require('./launch-target');
      const instance = await resolveLaunchTarget(directory, String(targetId ?? ''));
      return downloader.repairVersion(instance?.profileId ?? targetId, report, { signal });
    }, options)
  ));

  ipcMain.handle('minecraft:delete-version', async (_event, profileId) => {
    if (activeDownloads.size > 0) {
      throw new Error('请先等待下载完成或取消下载，再删除游戏版本');
    }
    await ensureMinecraftServices();
    if (gameProcesses.isBusy(gameDirectory)) throw new Error('请先关闭当前目录中运行的游戏，再删除游戏版本');
    return services.versionManager.deleteProfile(profileId);
  });

  registerTaskHandler(ipcMain, 'minecraft:launch-version', async (event, profileId) => {
    if (activeDownloads.size > 0) {
      throw new Error('请先等待下载完成或取消下载，再启动游戏');
    }
    const settingsStore = getSettingsStore();
    const settings = settingsStore
      ? await settingsStore.getState()
      : { gameDirectoryMode: 'local', memoryMb: 4096 };
    let binding;
    // Bind synchronously inside service selection, before another request can
    // switch the shared current-directory pointer after this await completes.
    await ensureMinecraftServices(settings, undefined, (selected) => { binding = selected; });
    const { directory: launchDirectory, services: launchServices } = binding;
    const requestedTargetId = String(profileId ?? '');
    const directoryGames = gameProcesses.forDirectory(launchDirectory);
    const preparingKey = `preparing:${requestedTargetId}`;
    if ([directoryGames.get(requestedTargetId), directoryGames.get(preparingKey)]
      .some((game) => game && game.exitCode == null)) {
      throw new Error(`${requestedTargetId} 已经在运行中或正在准备启动`);
    }
    const reservation = { exitCode: null, preparing: true };
    directoryGames.set(preparingKey, reservation);
    const sendStatus = (status) => {
      if (!event.sender.isDestroyed()) event.sender.send('minecraft:launch-status', { ...status, gameDirectory: launchDirectory });
    };
    try {
      sendStatus({ phase: 'preparing', profileId: requestedTargetId, targetId: requestedTargetId });
      const accountStore = getAccountStore();
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
      if (activeDownloads.size > 0) throw new Error('请先等待下载完成或取消下载，再启动游戏');
      const { resolveLaunchTarget, profileGameDirectory } = require('./launch-target');
      const instance = await resolveLaunchTarget(launchDirectory, requestedTargetId);
      const authlibInjectorPath = currentAccount?.type === 'yggdrasil'
        ? await launchServices.authlibInjector.ensureInstalled((progress) => sendStatus({
            phase: 'authlib-injector',
            profileId: instance?.profileId ?? requestedTargetId,
            targetId: requestedTargetId,
            ...progress
          }))
        : undefined;
      return await launchServices.launcher.launch({
        profileId: instance?.profileId ?? requestedTargetId,
        targetId: requestedTargetId,
        instanceDirectory: instance?.instanceDirectory ?? (settings.isolateProfiles !== false
          ? profileGameDirectory(launchDirectory, requestedTargetId) : undefined),
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
    } finally {
      if (directoryGames.get(preparingKey) === reservation) directoryGames.delete(preparingKey);
    }
  });

  let modManager;
  const getModManager = () => modManager ??= new (require('./mod-manager').ModManager)();
  async function targetDirectory(targetId, mutate = false) {
    const settings = await ensureMinecraftServices();
    if (mutate && (activeDownloads.size || gameProcesses.isBusy(gameDirectory))) {
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
