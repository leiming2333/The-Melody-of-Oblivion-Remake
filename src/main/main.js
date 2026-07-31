const path = require('node:path');
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage, shell } = require('electron');
const { registerAccountIpc } = require('./accounts/ipc');
const { AccountStore } = require('./accounts/account-store');
const { MicrosoftAuthManager } = require('./accounts/microsoft-auth');
const { YggdrasilAuthManager } = require('./accounts/yggdrasil-auth');
const { registerMinecraftIpc } = require('./minecraft/ipc');
const { registerSettingsIpc } = require('./settings/ipc');
const { SettingsStore } = require('./settings/settings-store');

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

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 760,
    height: 466,
    minWidth: 680,
    minHeight: 417,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
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

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const items = [];
    if (params.editFlags.canCut) items.push({ role: 'cut' });
    if (params.editFlags.canCopy) items.push({ role: 'copy' });
    if (params.editFlags.canPaste) items.push({ role: 'paste' });
    if (items.length > 0) items.push({ type: 'separator' });
    items.push({ role: 'selectAll' });
    Menu.buildFromTemplate(items).popup(mainWindow);
  });

  mainWindow.once('ready-to-show', () => {
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

app.whenReady().then(() => {
  const settingsStore = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  const accountStore = new AccountStore(
    path.join(app.getPath('userData'), 'accounts.json'),
    { secretCodec: createSecretCodec() }
  );
  const microsoftAuth = new MicrosoftAuthManager({ accountStore });
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
  createWindow();

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
