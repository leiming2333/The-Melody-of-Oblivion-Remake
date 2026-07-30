const path = require('node:path');
const { AccountStore } = require('./account-store');

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
  yggdrasilAuth
}) {
  const store = accountStore ?? new AccountStore(path.join(app.getPath('userData'), 'accounts.json'));

  ipcMain.handle('accounts:get-state', () => store.getState());
  ipcMain.handle('accounts:add-offline', (_event, playerName, skinModel) => (
    store.addOffline(playerName, skinModel)
  ));
  ipcMain.handle('accounts:begin-microsoft', async (event) => {
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
  ipcMain.handle('accounts:cancel-microsoft', (event, sessionId) => (
    microsoftAuth?.cancel(sessionId, event.sender.id) ?? { cancelled: false }
  ));
  ipcMain.handle('accounts:login-littleskin', (event, username, password) => {
    if (!yggdrasilAuth) throw new Error('LittleSkin 登录服务不可用');
    event.sender.once('destroyed', () => yggdrasilAuth.cancelOwner(event.sender.id));
    return yggdrasilAuth.login(event.sender.id, username, password);
  });
  ipcMain.handle('accounts:select-littleskin-profile', (event, sessionId, profileId) => {
    if (!yggdrasilAuth) throw new Error('LittleSkin 登录服务不可用');
    return yggdrasilAuth.selectProfile(sessionId, event.sender.id, profileId);
  });
  ipcMain.handle('accounts:select', (_event, accountId) => store.select(accountId));
  ipcMain.handle('accounts:set-skin-model', (_event, accountId, skinModel) => (
    store.setSkinModel(accountId, skinModel)
  ));
  ipcMain.handle('accounts:refresh-skin', (_event, accountId) => store.refreshSkin(accountId));
  ipcMain.handle('accounts:remove', (_event, accountId) => store.remove(accountId));
  return store;
}

module.exports = { normalizeMicrosoftDeviceCode, registerAccountIpc };
