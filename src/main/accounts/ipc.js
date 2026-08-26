const path = require('node:path');
const { AccountStore } = require('./account-store');

function registerAccountIpc({
  app,
  ipcMain,
  accountStore,
  yggdrasilAuth
}) {
  const store = accountStore ?? new AccountStore(path.join(app.getPath('userData'), 'accounts.json'));

  ipcMain.handle('accounts:get-state', () => store.getState());
  ipcMain.handle('accounts:add-offline', (_event, playerName, skinModel) => (
    store.addOffline(playerName, skinModel)
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
  ipcMain.handle('accounts:rename', (_event, accountId, newName) => (
    store.renameAccount(accountId, newName)
  ));
  ipcMain.handle('accounts:refresh-skin', (_event, accountId) => store.refreshSkin(accountId));
  ipcMain.handle('accounts:remove', (_event, accountId) => store.remove(accountId));
  return store;
}

module.exports = { registerAccountIpc };
