const path = require('node:path');
const { spawn } = require('node:child_process');
const { ModuleProcess } = require('../module-process');

class BackgroundUpdater {
  constructor({ app, BrowserWindow, settingsStore, shell, onUpdateAvailable, onUpdateReady }) {
    this.settingsStore = settingsStore;
    this.state = { status: app.isPackaged ? 'idle' : 'unavailable', platform: process.platform,
      currentVersion: app.getVersion?.() ?? '0.0.0', progress: 0, recovery: null,
      message: app.isPackaged ? '尚未检查更新' : '开发模式不检查更新' };
    const helpers = new Map();
    this.process = new ModuleProcess({ moduleName: 'updater', modulePath: path.join(__dirname, '../worker-modules/updater.js'),
      options: { isPackaged: app.isPackaged, version: app.getVersion?.() ?? '0.0.0', parentPid: process.pid,
        platform: process.platform, arch: process.arch,
        paths: Object.fromEntries(['userData', 'downloads', 'exe'].map((name) => [name, app.getPath(name)])),
        env: { PORTABLE_EXECUTABLE_FILE: process.env.PORTABLE_EXECUTABLE_FILE, APPIMAGE: process.env.APPIMAGE } },
      handlers: {
        showItemInFolder: (target) => shell?.showItemInFolder?.(target),
        trashItem: (target) => shell.trashItem(target),
        relaunch: () => app.relaunch?.(),
        quit: () => { setImmediate(() => app.quit()); return true; },
        cancelHelper: (id) => {
          const helper = helpers.get(id);
          helper?.controller.abort(); helper?.child?.kill?.();
          return true;
        },
        startHelper: async ({ helperId, record, store, platform, rollback, sourcePath }) => {
          const controller = new AbortController();
          const entry = { controller };
          helpers.set(helperId, entry);
          try {
            const { startInstallHelper, startWindowsHelper } = require('./install-helper');
            if (record) entry.child = await startInstallHelper({ record, store: { ...store, fs: require('node:fs/promises') }, platform, rollback,
              spawnProcess: spawn, parentPid: process.pid, signal: controller.signal });
            else {
              const { launchScript } = require('./windows-replacement');
              entry.child = await startWindowsHelper({ directory: path.dirname(sourcePath), spawnProcess: spawn,
                signal: controller.signal, makeScript: (options) => launchScript(sourcePath, process.pid, options) });
            }
            return true;
          } catch (error) { helpers.delete(helperId); throw error; }
        }
      }
    });
    this.process.on('event', (name, value) => {
      if (name === 'state') {
        this.state = value;
        for (const window of BrowserWindow?.getAllWindows?.() ?? []) {
          if (!window.isDestroyed?.() && !window.webContents.isDestroyed?.()) window.webContents.send('updater:state', value);
        }
      } else if (name === 'available') onUpdateAvailable?.(...value);
      else if (name === 'ready') onUpdateReady?.(...value);
    });
    this.process.on('stopped', (error) => {
      this.state = { ...this.state, status: 'error', canCancel: false, message: error.message };
      for (const window of BrowserWindow?.getAllWindows?.() ?? []) {
        if (!window.isDestroyed?.() && !window.webContents.isDestroyed?.()) window.webContents.send('updater:state', this.publicState());
      }
    });
  }
  publicState() { return { ...this.state }; }
  async initialize() { this.state = await this.process.invoke('initialize'); return this.publicState(); }
  check(options = {}) { return this.process.invoke('check', [options]); }
  download() { return this.process.invoke('download'); }
  install() { return this.process.invoke('install'); }
  cancel() { return this.process.invoke('cancel'); }
  confirmHealthy() { return this.process.invoke('confirmHealthy'); }
  recover(action) { return this.process.invoke('recover', [action]); }
  listHistory() { return this.process.invoke('listHistory'); }
  cleanupHistory(ids) { return this.process.invoke('cleanupHistory', [ids]); }
  dispose() { return this.process.dispose(); }
}

module.exports = { BackgroundUpdater };
