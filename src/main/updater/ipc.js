// Keep IPC registration independent of the update implementation.
const registrations = new WeakMap();

function registerUpdateIpc({ ipcMain, getUpdateManager }) {
  if (registrations.has(ipcMain)) return;
  ipcMain.handle('updater:get-state', () => getUpdateManager().publicState());
  ipcMain.handle('updater:check', async () => {
    const manager = getUpdateManager();
    const settings = await manager.settingsStore?.getState();
    return manager.check({ autoDownload: settings ? settings.launcherUpdatePolicy === 'auto' : true });
  });
  ipcMain.handle('updater:download', () => getUpdateManager().download());
  ipcMain.handle('updater:install', () => getUpdateManager().install());
  registrations.set(ipcMain, true);
}

module.exports = { registerUpdateIpc };
