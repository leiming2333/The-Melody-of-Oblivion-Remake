const path = require('node:path');
const { javaMajorVersion } = require('../minecraft/java-runtime');

function registerSettingsIpc({ BrowserWindow, dialog, ipcMain, settingsStore }) {
  ipcMain.handle('settings:get-state', () => settingsStore.getState());
  ipcMain.handle('settings:update', (_event, patch = {}) => settingsStore.update(patch));
  ipcMain.handle('settings:select-java', async (event) => {
    const options = {
      title: '选择 Java 可执行文件',
      buttonLabel: '选择 Java',
      properties: ['openFile', 'dontAddToRecent'],
      filters: process.platform === 'win32'
        ? [{ name: 'Java 可执行文件', extensions: ['exe'] }]
        : [{ name: '所有文件', extensions: ['*'] }]
    };
    const owner = BrowserWindow.fromWebContents(event.sender);
    const selection = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    if (selection.canceled || !selection.filePaths[0]) return { canceled: true };

    const javaPath = path.resolve(selection.filePaths[0]);
    const majorVersion = await javaMajorVersion(javaPath);
    if (!Number.isInteger(majorVersion)) {
      throw new Error('所选文件不是可用的 Java，请选择 Java 安装目录 bin 文件夹中的 java.exe');
    }
    return { canceled: false, javaPath, majorVersion };
  });
}

module.exports = { registerSettingsIpc };
