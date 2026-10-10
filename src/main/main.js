const { StartupMetrics } = require('./startup-metrics');
const startupMetrics = new StartupMetrics();
startupMetrics.mark('main-entry');
const path = require('node:path');
const { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } = require('electron');
const { createLazyServices } = require('./lazy-services');

const isSmokeTest = process.argv.includes('--smoke-test');
const iconFile = process.platform === 'win32' ? 'app-icon.ico'
  : process.platform === 'darwin' ? 'app-icon.icns'
  : 'app-icon.png';
const appIconPath = path.join(__dirname, '../renderer/assets', iconFile);
const windowReadiness = new WeakMap();
let backgroundInitialized = false;
if (isSmokeTest) {
  app.disableHardwareAcceleration();
  app.setPath('userData', path.join(app.getPath('temp'), 'melody-of-oblivion-smoke'));
}
if (process.platform === 'win32') {
  app.setAppUserModelId('com.melodyofoblivion.launcher');
}

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

ipcMain.on('diagnostics:error', (_event, message) => {
  if (typeof message === 'string') void services.errorLog.record(message);
});

ipcMain.handle('shell:open-external', async (_event, url) => {
  const target = String(url ?? '');
  if (/^https?:\/\//i.test(target)) {
    await shell.openExternal(target);
    return true;
  }
  return false;
});

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
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: '#00000000',
    icon: appIconPath,
    title: '忘却的旋律启动器',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  let resolveShown;
  windowReadiness.set(mainWindow, new Promise((resolve) => { resolveShown = resolve; }));
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

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
    setImmediate(() => {
      if (!isSmokeTest) {
        void initializeBackgroundServices().catch((error) => console.error('后台初始化失败', error));
      }
    });
  });

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const valid = await mainWindow.webContents.executeJavaScript(`Boolean(
          document.querySelector('#launchButton') && document.querySelector('#accountDialog') &&
          !document.querySelector('#modsButton') && window.launcherEnvironment?.accounts?.getState &&
          window.launcherEnvironment?.minecraft?.importModFile
        )`);
        if (!valid) throw new Error('Smoke test: renderer or preload API missing');
        await mainWindow.webContents.executeJavaScript(`Promise.all([
          import('./modules/account-ui.mjs').then(m => typeof m.renderAccountList === 'function'),
          import('./modules/modpack-ui.mjs').then(m => typeof m.installDroppedModpack === 'function')
        ]).then(values => { if (!values.every(Boolean)) throw new Error('Missing renderer module'); })`);
        if (process.env.MELODY_SMOKE_RESULT) {
          await require('node:fs/promises').writeFile(process.env.MELODY_SMOKE_RESULT, JSON.stringify({
            ok: true, packaged: app.isPackaged, platform: process.platform, arch: process.arch, version: app.getVersion()
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

function createSecretCodec() {
  const prefix = 'safe-storage:v1:';
  return {
    encode(value) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统凭据存储当前不可用，已拒绝保存在线账户登录信息');
      }
      return `${prefix}${safeStorage.encryptString(value).toString('base64')}`;
    },
    decode(value) {
      if (!String(value).startsWith(prefix)) {
        throw new Error('检测到未加密的在线账户登录信息，请删除该账户后重新登录');
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统凭据存储当前不可用，无法读取在线账户登录信息');
      }
      return safeStorage.decryptString(Buffer.from(String(value).slice(prefix.length), 'base64'));
    }
  };
}

const services = createLazyServices({
  errorLog: () => {
    const { ErrorLog } = require('./error-log');
    return new ErrorLog(app.getPath('userData'));
  },
  accountStore: () => {
    const { AccountStore } = require('./accounts/account-store');
    return new AccountStore(path.join(app.getPath('userData'), 'accounts.json'), { secretCodec: createSecretCodec() });
  },
  settingsStore: () => {
    const { SettingsStore } = require('./settings/settings-store');
    return new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  },
  microsoftAuth: () => {
    const { MicrosoftAuth } = require('./accounts/microsoft-auth');
    return new MicrosoftAuth({ accountStore: getAccountStore() });
  },
  yggdrasilAuth: () => {
    const { YggdrasilAuthManager } = require('./accounts/yggdrasil-auth');
    return new YggdrasilAuthManager({ accountStore: getAccountStore() });
  },
  javaProbeCache: () => {
    const { JavaProbeCache } = require('./minecraft/java-probe-cache');
    return new JavaProbeCache(path.join(app.getPath('userData'), 'java-cache.json'));
  },
  updateManager: () => {
    const { UpdateManager } = require('./updater/update-manager');
    return new UpdateManager({
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
});
function getAccountStore() { return services.accountStore; }
function getSettingsStore() { return services.settingsStore; }
function getMicrosoftAuth() { return services.microsoftAuth; }
function getYggdrasilAuth() { return services.yggdrasilAuth; }
function getJavaProbeCache() { return services.javaProbeCache; }
function getUpdateManager() { return services.updateManager; }

async function initializeBackgroundServices() {
  if (backgroundInitialized) return;
  backgroundInitialized = true;
  const settings = await getSettingsStore().getState();
  if (settings.launcherUpdatePolicy !== 'off') {
    setTimeout(() => {
      void getUpdateManager().check({ autoDownload: settings.launcherUpdatePolicy === 'auto' });
    }, 5000);
  }
}

app.whenReady().then(() => {
  startupMetrics.attach(app.getPath('userData'));
  startupMetrics.mark('electron-ready');
  require('./accounts/ipc').registerAccountIpc({ app, ipcMain, getAccountStore, getMicrosoftAuth, getYggdrasilAuth });
  require('./settings/ipc').registerSettingsIpc({ BrowserWindow, dialog, ipcMain, getSettingsStore, getJavaProbeCache });
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
