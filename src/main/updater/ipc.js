// Keep IPC registration independent of the update implementation.
const registrations = new WeakMap();
const { registerTaskHandler } = require('../../shared/task-errors');

function registerUpdateIpc({ ipcMain, getUpdateManager }) {
  if (registrations.has(ipcMain)) return;
  registerTaskHandler(ipcMain, 'updater:get-state', async () => {
    const manager = getUpdateManager();
    await manager.initialize?.();
    return manager.publicState();
  });
  registerTaskHandler(ipcMain, 'updater:check', async () => {
    const manager = getUpdateManager();
    const settings = await manager.settingsStore?.getState();
    return manager.check({ autoDownload: settings ? settings.launcherUpdatePolicy === 'auto' : true });
  });
  registerTaskHandler(ipcMain, 'updater:download', () => getUpdateManager().download());
  registerTaskHandler(ipcMain, 'updater:install', () => getUpdateManager().install());
  registerTaskHandler(ipcMain, 'updater:cancel', () => getUpdateManager().cancel());
  registerTaskHandler(ipcMain, 'updater:recover', (_event, action) => getUpdateManager().recover(action));
  registerTaskHandler(ipcMain, 'updater:list-history', () => getUpdateManager().listHistory());
  registerTaskHandler(ipcMain, 'updater:cleanup-history', (_event, ids) => getUpdateManager().cleanupHistory(ids));
  registrations.set(ipcMain, true);
}

module.exports = { registerUpdateIpc };
