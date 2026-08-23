const path = require('node:path');
const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require('electron');
const { registerAccountIpc } = require('./accounts/ipc');
const { AccountStore } = require('./accounts/account-store');
const { MicrosoftAuthManager } = require('./accounts/microsoft-auth');
const { YggdrasilAuthManager } = require('./accounts/yggdrasil-auth');
const { registerMinecraftIpc } = require('./minecraft/ipc');
const { registerSettingsIpc } = require('./settings/ipc');
const { SettingsStore } = require('./settings/settings-store');
const { UpdateManager } = require('./updater/update-manager');

const isSmokeTest = process.argv.includes('--smoke-test');
const iconFile = process.platform === 'win32' ? 'app-icon.ico'
  : process.platform === 'darwin' ? 'app-icon.icns'
  : 'app-icon.png';
const appIconPath = path.join(__dirname, '../renderer/assets', iconFile);
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

ipcMain.handle('shell:open-external', async (_event, url) => {
  const target = String(url ?? '');
  if (/^https?:\/\//i.test(target)) {
    await shell.openExternal(target);
    return true;
  }
  return false;
});

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

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    if (process.platform !== 'darwin') {
      mainWindow.setIcon(appIconPath);
    }
    if (!isSmokeTest) {
      mainWindow.show();
    }
  });

  if (isSmokeTest) {
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('SMOKE_TEST_OK');
      app.quit();
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

function loadMicrosoftClientId() {
  // 优先使用环境变量（本地开发/测试覆盖）
  const envClientId = String(process.env.MELODY_MICROSOFT_CLIENT_ID ?? '').trim();
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){2}[0-9a-f]{4}-[0-9a-f]{12}$/i.test(envClientId)) {
    return envClientId.toLowerCase();
  }
  // 构建时注入的 Client ID（src/main/accounts/microsoft-client-id.json，已 gitignore）
  try {
    const { clientId } = require('./accounts/microsoft-client-id.json');
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){2}[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId ?? '')) {
      return String(clientId).toLowerCase();
    }
  } catch {}
  return undefined;
}

app.whenReady().then(async () => {
  const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  const accountStore = new AccountStore(
    path.join(app.getPath('userData'), 'accounts.json'),
    { secretCodec: createSecretCodec() }
  );
  const microsoftAuth = new MicrosoftAuthManager({
    accountStore,
    clientId: loadMicrosoftClientId()
  });
  const yggdrasilAuth = new YggdrasilAuthManager({ accountStore });
  registerAccountIpc({
    app,
    ipcMain,
    shell,
    clipboard,
    accountStore,
    microsoftAuth,
    yggdrasilAuth
  });
  registerSettingsIpc({ BrowserWindow, dialog, ipcMain, settingsStore });
  registerMinecraftIpc({
    app,
    ipcMain,
    shell,
    settingsStore,
    accountStore,
    microsoftAuth,
    yggdrasilAuth
  });
  const updateManager = new UpdateManager({
    app,
    BrowserWindow,
    ipcMain,
    shell,
    onUpdateAvailable: (version, releaseUrl) => {
      const parentWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      dialog.showMessageBox(parentWindow, {
        type: 'info',
        title: '启动器更新',
        message: `发现新版本 v${version}`,
        detail: '启动器已在后台下载更新，完成后可在「启动器设置」中重启安装。',
        buttons: ['稍后提醒', '查看发布页'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      }).then(({ response }) => {
        if (response === 1 && releaseUrl) {
          shell.openExternal(releaseUrl);
        }
      }).catch(() => {});
    }
  });
  updateManager.start();
  createWindow();

  const settings = await settingsStore.getState();
  if (settings.launcherAutoUpdate) {
    setTimeout(() => void updateManager.check(), 5000);
  }

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
