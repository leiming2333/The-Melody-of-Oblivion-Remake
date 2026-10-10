const path = require('node:path');

function registerAccountIpc({
  app,
  ipcMain,
  accountStore,
  yggdrasilAuth,
  getAccountStore = () => {
    if (!accountStore) {
      const { AccountStore } = require('./account-store');
      accountStore = new AccountStore(path.join(app.getPath('userData'), 'accounts.json'));
    }
    return accountStore;
  },
  getMicrosoftAuth = () => undefined,
  getYggdrasilAuth = () => yggdrasilAuth
}) {
  ipcMain.handle('accounts:login-microsoft', async (event) => {
    const auth = getMicrosoftAuth();
    if (!auth) throw new Error('Microsoft 登录服务不可用');
    const cancel = () => auth.cancelOwner(event.sender.id);
    event.sender.once('destroyed', cancel);
    try {
      return await auth.login(event.sender.id, code => {
        if (!event.sender.isDestroyed()) event.sender.send('accounts:microsoft-code', code);
      });
    } finally { event.sender.removeListener('destroyed', cancel); }
  });
  ipcMain.handle('accounts:cancel-microsoft', event => { getMicrosoftAuth()?.cancelOwner(event.sender.id); });
  ipcMain.handle('accounts:get-state', () => getAccountStore().getState());
  ipcMain.handle('accounts:add-offline', (_event, playerName, skinModel) => (
    getAccountStore().addOffline(playerName, skinModel)
  ));
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

module.exports = { registerAccountIpc };
