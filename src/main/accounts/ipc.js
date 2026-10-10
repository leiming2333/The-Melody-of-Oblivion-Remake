const path = require('node:path');

function normalizeMicrosoftDeviceCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,24}$/.test(code)) throw new Error('Microsoft 登录代码无效');
  return code;
}

function registerAccountIpc({
  app,
  ipcMain,
  shell,
  clipboard,
  accountStore,
  microsoftAuth,
  yggdrasilAuth,
  getAccountStore = () => {
    if (!accountStore) {
      const { AccountStore } = require('./account-store');
      accountStore = new AccountStore(path.join(app.getPath('userData'), 'accounts.json'));
    }
    return accountStore;
  },
  getMicrosoftAuth = () => microsoftAuth,
  getYggdrasilAuth = () => yggdrasilAuth
}) {
  ipcMain.handle('accounts:get-state', () => getAccountStore().getState());
  ipcMain.handle('accounts:add-offline', (_event, playerName, skinModel) => (
    getAccountStore().addOffline(playerName, skinModel)
  ));
  ipcMain.handle('accounts:begin-microsoft', async (event) => {
    const microsoftAuth = getMicrosoftAuth();
    if (!microsoftAuth) throw new Error('Microsoft 登录服务不可用');
    const result = await microsoftAuth.begin(event.sender.id);
    try {
      clipboard?.writeText(normalizeMicrosoftDeviceCode(result.userCode));
    } catch {}
    try {
      const verificationUrl = new URL(result.verificationUri);
      if (
        verificationUrl.protocol === 'https:'
        && (verificationUrl.hostname === 'microsoft.com'
          || verificationUrl.hostname.endsWith('.microsoft.com'))
      ) {
        await shell?.openExternal(result.verificationUri);
      }
    } catch {}
    event.sender.once('destroyed', () => microsoftAuth.cancelOwner(event.sender.id));
    return result;
  });
  ipcMain.handle('accounts:complete-microsoft', (event, sessionId) => {
    const microsoftAuth = getMicrosoftAuth();
    if (!microsoftAuth) throw new Error('Microsoft 登录服务不可用');
    return microsoftAuth.complete(sessionId, event.sender.id, (progress) => {
      if (!event.sender.isDestroyed?.()) {
        event.sender.send('accounts:microsoft-progress', { sessionId, ...progress });
      }
    });
  });
  ipcMain.handle('accounts:copy-microsoft-code', (_event, code) => {
    if (!clipboard) throw new Error('系统剪贴板不可用');
    clipboard.writeText(normalizeMicrosoftDeviceCode(code));
    return { copied: true };
  });
  ipcMain.handle('accounts:login-microsoft', async (event) => {
    const auth = getMicrosoftAuth();
    if (!auth) throw new Error('Microsoft 登录服务不可用');
    const cancel = () => auth.cancelOwner(event.sender.id);
    event.sender.once('destroyed', cancel);
    try {
      const session = await auth.begin(event.sender.id);
      if (!event.sender.isDestroyed?.()) event.sender.send('accounts:microsoft-code', {
        ...session, expiresIn: Math.max(0, (session.expiresAt - Date.now()) / 1000)
      });
      return await auth.complete(session.sessionId, event.sender.id);
    } finally { event.sender.removeListener('destroyed', cancel); }
  });
  ipcMain.handle('accounts:cancel-microsoft', (event, sessionId) => {
    const auth = getMicrosoftAuth();
    if (!sessionId) { auth?.cancelOwner(event.sender.id); return { cancelled: true }; }
    return auth?.cancel(sessionId, event.sender.id) ?? { cancelled: false };
  });
  ipcMain.handle('accounts:login-littleskin', (event, username, password) => {
    const yggdrasilAuth = getYggdrasilAuth();
    if (!yggdrasilAuth) throw new Error('LittleSkin 登录服务不可用');
    event.sender.once('destroyed', () => yggdrasilAuth.cancelOwner(event.sender.id));
    return yggdrasilAuth.login(event.sender.id, username, password);
  });
  ipcMain.handle('accounts:select-littleskin-profile', (event, sessionId, profileId) => {
    const yggdrasilAuth = getYggdrasilAuth();
    if (!yggdrasilAuth) throw new Error('LittleSkin 登录服务不可用');
    return yggdrasilAuth.selectProfile(sessionId, event.sender.id, profileId);
  });
  ipcMain.handle('accounts:select', (_event, accountId) => getAccountStore().select(accountId));
  ipcMain.handle('accounts:set-skin-model', (_event, accountId, skinModel) => (
    getAccountStore().setSkinModel(accountId, skinModel)
  ));
  ipcMain.handle('accounts:rename', (_event, accountId, newName) => (
    getAccountStore().renameAccount(accountId, newName)
  ));
  ipcMain.handle('accounts:refresh-skin', (_event, accountId) => getAccountStore().refreshSkin(accountId));
  ipcMain.handle('accounts:remove', (_event, accountId) => getAccountStore().remove(accountId));
  return accountStore ?? getAccountStore;
}

module.exports = { normalizeMicrosoftDeviceCode, registerAccountIpc };
