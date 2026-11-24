const { StartupMetrics } = require('./startup-metrics');
const startupMetrics = new StartupMetrics();
startupMetrics.mark('main-entry');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, safeStorage, shell } = require('electron');
const { createLazyServices } = require('./lazy-services');
const { registerTaskHandler } = require('../shared/task-errors');
// loadFile and pathToFileURL encode '~' differently, including Windows 8.3
// paths. Navigate to the exact URL used by the trusted-document checks.
const rendererUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;

const isSmokeTest = process.argv.includes('--smoke-test');
const smokeResultArgument = isSmokeTest && process.argv.find((argument) => argument.startsWith('--smoke-result='));
const smokeResultPath = isSmokeTest ? (smokeResultArgument
  ? smokeResultArgument.slice('--smoke-result='.length) : process.env.MELODY_SMOKE_RESULT) : undefined;
if (smokeResultPath && !path.isAbsolute(smokeResultPath)) throw new Error('Smoke result path must be absolute');
const iconFile = process.platform === 'win32' ? 'app-icon.ico'
  : process.platform === 'darwin' ? 'app-icon.icns'
  : 'app-icon.png';
const appIconPath = path.join(__dirname, '../renderer/assets', iconFile);
const windowReadiness = new WeakMap();
const preparedWindows = new WeakSet();
let backgroundInitialized = false;
let startupPreparation;
if (isSmokeTest) {
  app.disableHardwareAcceleration();
  const suffix = require('node:crypto').randomUUID();
  app.setPath('userData', smokeResultPath
    ? path.join(path.dirname(smokeResultPath), `user-data-${suffix}`)
    : path.join(app.getPath('temp'), `melody-of-oblivion-smoke-${suffix}`));
  // Exercise a genuine first launch without reading or creating the user's games.
  process.env.PORTABLE_EXECUTABLE_DIR = app.getPath('userData');
}
if (process.platform === 'win32') {
  app.setAppUserModelId('com.melodyofoblivion.launcher');
}
const hasSingleInstanceLock = require('./single-instance').acquireSingleInstance(app, BrowserWindow, createWindow);
if (!hasSingleInstanceLock) app.quit();
const windowHealth = require('./window-health').createWindowHealth({
  BrowserWindow,
  expectedUrl: rendererUrl,
  isEligible: () => app.isPackaged && !isSmokeTest && hasSingleInstanceLock,
  onHealthy: async () => {
    const manager = getUpdateManager();
    await manager.initialize?.();
    await manager.confirmHealthy();
  },
  onError: (error) => { void services.errorLog.record(`更新启动确认失败：${error.message}`); }
});

ipcMain.on('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});

ipcMain.on('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.on('startup:stage', (_event, stage) => {
  if (['renderer-painted', 'settings-loaded', 'accounts-loaded', 'profiles-loaded', 'java-detected', 'core-ready'].includes(stage)) {
    const alreadyRecorded = startupMetrics.stages.some((entry) => entry.stage === stage);
    startupMetrics.mark(stage);
    if (stage === 'core-ready' && !alreadyRecorded && !app.isPackaged && !isSmokeTest) startupMetrics.print();
  }
});

ipcMain.handle('startup:when-window-shown', (event) => {
  return windowReadiness.get(BrowserWindow.fromWebContents(event.sender)) ?? Promise.resolve();
});
registerTaskHandler(ipcMain, 'startup:prepare', async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const shown = windowReadiness.get(window);
  if (!shown || event.senderFrame !== event.sender.mainFrame
      || event.sender.getURL() !== rendererUrl) {
    throw new Error('无法准备当前启动器窗口');
  }
  preparedWindows.delete(window);
  await shown;
  startupPreparation ??= require('./startup-preparation').createStartupPreparation({ app });
  const result = await startupPreparation.prepare((progress) => {
    if (!event.sender.isDestroyed()) event.sender.send('startup:progress', progress);
  });
  preparedWindows.add(window);
  return result;
});
ipcMain.handle('startup:renderer-ready', (event) => {
  if (!preparedWindows.has(BrowserWindow.fromWebContents(event.sender))
      || event.senderFrame !== event.sender.mainFrame
      || event.sender.getURL() !== rendererUrl) return false;
  if (!isSmokeTest) {
    require('./portable-runtime').cleanupPortableRuntime().catch(() => {});
    void initializeBackgroundServices().catch((error) => console.error('后台初始化失败', error));
  }
  return windowHealth.ready(event);
});
ipcMain.handle('diagnostics:copy-error', (_event, message) => {
  clipboard.writeText(require('./error-log').redactError(String(message)));
  return true;
});
ipcMain.handle('diagnostics:export-report', (event, message) => (
  services.errorLog.exportReport(event.sender, String(message ?? ''))
));

ipcMain.handle('shell:open-external', require('./external-links').createExternalLinkHandler({
  shell, BrowserWindow, rendererUrl
}));

function focusLauncherUpdateSettings() {
  const parentWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
  if (!parentWindow) return;
  if (parentWindow.isMinimized()) parentWindow.restore();
  parentWindow.show?.();
  parentWindow.focus?.();
  parentWindow.webContents.send('updater:show-settings');
}

function showLauncherUpdateNotification(title, body) {
  if (typeof Notification !== 'function' || !Notification.isSupported()) {
    return false;
  }
  try {
    const notification = new Notification({ title, body, icon: appIconPath });
    notification.on('click', () => focusLauncherUpdateSettings());
    notification.show();
    return true;
  } catch {
    return false;
  }
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 760,
    height: 466,
    minWidth: 680,
    minHeight: 417,
    show: false,
    frame: false,
    transparent: false,
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#171012',
    icon: appIconPath,
    title: '忘却的旋律启动器',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !isSmokeTest
    }
  });

  let resolveShown;
  windowHealth.track(mainWindow);
  windowReadiness.set(mainWindow, new Promise((resolve) => { resolveShown = resolve; }));
  if (process.platform !== 'darwin') {
    // Reapply after the native window appears so Windows refreshes its taskbar button.
    mainWindow.on('show', () => mainWindow.setIcon(appIconPath));
  }
  mainWindow.loadURL(rendererUrl);

  mainWindow.once('ready-to-show', () => {
    startupMetrics.mark('ready-to-show');
    startupMetrics.mark('window-ready');
    if (process.platform !== 'darwin') {
      mainWindow.setIcon(appIconPath);
    }
    if (!isSmokeTest) {
      mainWindow.show();
      startupMetrics.mark('window-shown');
    }
    resolveShown();
  });

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const valid = await mainWindow.webContents.executeJavaScript(`Boolean(
          document.querySelector('#launchButton') && document.querySelector('#accountDialog') &&
          document.querySelector('#problemExportReportButton') &&
          !document.querySelector('#modsButton') && window.launcherEnvironment?.accounts?.getState &&
          window.launcherEnvironment?.minecraft?.importModFile &&
          window.launcherEnvironment?.minecraft?.repairVersion &&
          window.launcherEnvironment?.diagnostics?.exportReport &&
          document.querySelector('#fabricApiDialog') &&
          window.launcherEnvironment?.minecraft?.listFabricApiVersions &&
          document.querySelector('#startupScreen') && document.querySelector('#launcherStage') &&
          window.launcherEnvironment?.startup?.prepare
        )`);
        if (!valid) throw new Error('Smoke test: renderer or preload API missing');
        await mainWindow.webContents.executeJavaScript(`Promise.all([
          import('./modules/account-ui.mjs').then(m => typeof m.renderAccountList === 'function'),
          import('./modules/modpack-ui.mjs').then(m => typeof m.installDroppedModpack === 'function'),
          import('./modules/launcher-update-ui.mjs').then(m => typeof m.createLauncherUpdateUi === 'function'),
          import('./modules/fabric-api-ui.mjs').then(m => typeof m.createFabricApiUi === 'function')
        ]).then(values => { if (!values.every(Boolean)) throw new Error('Missing renderer module'); })`);
        await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const screen = document.querySelector('#startupScreen');
          const stage = document.querySelector('#launcherStage');
          const timer = setTimeout(() => { observer.disconnect(); reject(new Error('Startup preparation timed out')); }, 45000);
          const check = () => {
            if (screen.dataset.state === 'error') {
              clearTimeout(timer); observer.disconnect();
              reject(new Error(document.querySelector('#startupError')?.textContent
                || document.querySelector('#startupMessage')?.textContent || 'Startup preparation failed'));
            } else if (screen.dataset.state === 'ready' && screen.hidden && !stage.inert) {
              clearTimeout(timer); observer.disconnect(); resolve();
            }
          };
          const observer = new MutationObserver(check);
          observer.observe(screen, { attributes: true, childList: true, subtree: true });
          observer.observe(stage, { attributes: true });
          check();
        })`);
        if (!preparedWindows.has(mainWindow)) throw new Error('Smoke test: startup preparation was not completed');
        // Exercise the real child runtime and its app.asar path in packaged builds.
        const { LoaderInstallProcess } = require('./minecraft/loader-install-process');
        try {
          await new LoaderInstallProcess().installLoader({ gameVersion: '../invalid', loaderType: 'forge' });
          throw new Error('Smoke test: installer validation was bypassed');
        } catch (error) {
          if (!error.message.includes('Minecraft 版本号格式无效')) throw error;
        }
        const fileSystem = require('node:fs/promises');
        // Store readiness is checked separately; it never gates the home UI.
        await Promise.all([getSettingsStore().prepare(), getAccountStore().getState()]);
        for (const name of ['settings.json', 'accounts.json']) {
          JSON.parse(await fileSystem.readFile(path.join(app.getPath('userData'), name), 'utf8'));
        }
        if (smokeResultPath) {
          await fileSystem.writeFile(smokeResultPath, JSON.stringify({
            ok: true, startupReady: true, packaged: app.isPackaged, platform: process.platform, arch: process.arch, version: app.getVersion()
          }));
        }
        console.log('SMOKE_TEST_OK');
        app.quit();
      } catch (error) {
        console.error(error.message);
        app.exit(1);
      }
    });
  }
}

const services = createLazyServices({
  errorLog: () => {
    const { BackgroundDiagnostics } = require('./background-diagnostics');
    return new BackgroundDiagnostics({ app, dialog, BrowserWindow, getSettingsStore });
  },
  accountStore: () => {
    const { BackgroundAccounts } = require('./accounts/background-accounts');
    const { createSecretCodec } = require('./accounts/secret-codec');
    return new BackgroundAccounts(path.join(app.getPath('userData'), 'accounts.json'), { secretCodec: createSecretCodec(safeStorage) });
  },
  settingsStore: () => {
    const { BackgroundSettings } = require('./settings/background-settings');
    return new BackgroundSettings(path.join(app.getPath('userData'), 'settings.json'));
  },
  microsoftAuth: () => {
    const { BackgroundAccountAuth } = require('./accounts/background-accounts');
    return new BackgroundAccountAuth({ provider: 'microsoft', getAccountStore,
      getClientId: async () => require('./accounts/microsoft-client-config').microsoftClientConfiguration({
        settings: await getSettingsStore().getState()
      }).clientId });
  },
  yggdrasilAuth: () => {
    const { BackgroundAccountAuth } = require('./accounts/background-accounts');
    return new BackgroundAccountAuth({ provider: 'littleskin', getAccountStore });
  },
  javaProbeCache: () => {
    const { JavaProbeCache } = require('./minecraft/java-probe-cache');
    return new JavaProbeCache(path.join(app.getPath('userData'), 'java-cache.json'));
  },
  javaDetection: () => {
    const { createJavaBackgroundService } = require('./minecraft/background-services');
    return createJavaBackgroundService({ cachePath: path.join(app.getPath('userData'), 'java-settings-cache.json'),
      launcherDirectory: require('./minecraft/ipc').launcherDirectory(app) });
  },
  updateManager: () => {
    const { BackgroundUpdater } = require('./updater/background-updater');
    return new BackgroundUpdater({
      app,
      BrowserWindow,
      ipcMain,
      settingsStore: getSettingsStore(),
      shell,
      onUpdateAvailable: (version, releaseUrl, autoDownload) => {
        const detail = autoDownload
          ? `新版本 v${version} 已发布，启动器正在后台下载更新。`
          : `新版本 v${version} 已发布，可在「启动器设置」中查看更新日志并下载。`;
        if (showLauncherUpdateNotification('发现启动器新版本', detail)) {
          return;
        }
        const parentWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
        dialog.showMessageBox(parentWindow, {
          type: 'info',
          title: '启动器更新',
          message: `发现新版本 v${version}`,
          detail: autoDownload
            ? '启动器已在后台下载更新，完成后可在「启动器设置」中重启安装。'
            : '可在「启动器设置」中查看更新日志并手动下载安装。',
          buttons: ['稍后提醒', '查看发布页'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        }).then(({ response }) => {
          if (response === 1 && releaseUrl) {
            shell.openExternal(releaseUrl);
          }
        }).catch(() => {});
      },
      onUpdateReady: (version, installAction) => {
        const detail = installAction === 'open-folder'
          ? `新版本 v${version} 已下载完成，请解压压缩包并替换旧版本。`
          : `新版本 v${version} 已下载完成，重启启动器即可完成更新。`;
        if (showLauncherUpdateNotification('启动器更新已就绪', detail)) {
          return;
        }
        const parentWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
        dialog.showMessageBox(parentWindow, {
          type: 'info',
          title: '启动器更新',
          message: '更新已就绪',
          detail,
          buttons: ['稍后提醒', '打开设置'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        }).then(({ response }) => {
          if (response === 1) {
            focusLauncherUpdateSettings();
          }
        }).catch(() => {});
      }
    });
  }
}, {
  onLoaded: (service) => {
    startupMetrics.recordEvent('lazy-service-loaded', { service });
    if (!app.isPackaged && !isSmokeTest) {
      console.table([{ event: 'lazy-service-loaded', service,
        elapsedMs: Math.round(require('node:perf_hooks').performance.now() - startupMetrics.start) }]);
    }
  }
});

ipcMain.on('diagnostics:error', (_event, message) => {
  if (typeof message === 'string') void services.errorLog.record(message);
});

function getAccountStore() { return services.accountStore; }
function getSettingsStore() { return services.settingsStore; }
function getMicrosoftAuth() { return services.microsoftAuth; }
function getYggdrasilAuth() { return services.yggdrasilAuth; }
function getJavaProbeCache() { return services.javaProbeCache; }
function getJavaService() { return services.javaDetection; }
function getUpdateManager() { return services.updateManager; }

async function initializeBackgroundServices() {
  if (backgroundInitialized) return;
  backgroundInitialized = true;
  const settings = await getSettingsStore().getState();
  if (settings.launcherUpdatePolicy !== 'off') {
    setTimeout(() => {
      void Promise.resolve().then(() => getUpdateManager().check({ autoDownload: settings.launcherUpdatePolicy === 'auto' }))
        .catch((error) => services.errorLog.record(`后台更新检查失败：${error.message}`));
    }, 5000);
  }
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  startupMetrics.attach(app.getPath('userData'));
  startupMetrics.mark('electron-ready');
  require('./accounts/ipc').registerAccountIpc({ app, ipcMain, shell, clipboard, getAccountStore, getSettingsStore, getMicrosoftAuth, getYggdrasilAuth });
  require('./settings/ipc').registerSettingsIpc({ BrowserWindow, dialog, ipcMain, getSettingsStore, getJavaProbeCache, getJavaService });
  require('./minecraft/ipc').registerMinecraftIpc({
    app, ipcMain, shell, dialog, BrowserWindow, getSettingsStore, getAccountStore, getMicrosoftAuth, getYggdrasilAuth, getJavaProbeCache
  });
  require('./updater/ipc').registerUpdateIpc({ ipcMain, getUpdateManager });
  startupMetrics.mark('services-registered');
  createWindow();
  startupMetrics.mark('window-created');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let modulesStopping = false;
let modulesStopped = false;
app.on('before-quit', (event) => {
  if (modulesStopped) return;
  const runtime = require.cache[require.resolve('./module-process')];
  const installers = require.cache[require.resolve('./minecraft/loader-install-process')];
  if (!runtime && !installers) return;
  event.preventDefault();
  if (modulesStopping) return;
  modulesStopping = true;
  void Promise.allSettled([
    runtime?.exports.disposeModuleProcesses(),
    installers?.exports.disposeLoaderInstallProcesses()
  ]).finally(() => {
    modulesStopped = true;
    app.quit();
  });
});
