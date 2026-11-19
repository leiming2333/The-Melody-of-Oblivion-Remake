const path = require('node:path');
const { ModuleProcess } = require('./module-process');

class BackgroundDiagnostics {
  constructor({ app, dialog, BrowserWindow, getSettingsStore }) {
    Object.assign(this, { dialog, BrowserWindow });
    this.process = new ModuleProcess({ moduleName: 'diagnostics',
      modulePath: path.join(__dirname, 'worker-modules/diagnostics.js'),
      options: { userData: app.getPath('userData'), home: app.getPath('home'),
        isPackaged: app.isPackaged, version: app.getVersion?.() ?? require('../../package.json').version },
      handlers: { getSettings: () => getSettingsStore().getState() } });
  }
  record(message) { return this.process.invoke('record', [message]).catch(() => {}); }
  async exportReport(sender, message) {
    const ownerWindow = this.BrowserWindow.fromWebContents(sender);
    const options = { title: '导出诊断报告', buttonLabel: '保存诊断报告', defaultPath: 'Melody-diagnostics.json',
      filters: [{ name: 'JSON 诊断报告', extensions: ['json'] }] };
    const selected = ownerWindow ? await this.dialog.showSaveDialog(ownerWindow, options)
      : await this.dialog.showSaveDialog(options);
    if (selected.canceled || !selected.filePath) return { canceled: true };
    return this.process.invoke('exportReport', [selected.filePath, message]);
  }
  dispose() { return this.process.dispose(); }
}

module.exports = { BackgroundDiagnostics };
