const UPDATE_CHANNEL = 'updater:state';

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

class UpdateManager {
  constructor({ app, autoUpdater, BrowserWindow, ipcMain } = {}) {
    this.app = app;
    this.autoUpdater = autoUpdater;
    this.BrowserWindow = BrowserWindow;
    this.ipcMain = ipcMain;
    this.started = false;
    this.state = {
      status: app?.isPackaged ? 'idle' : 'unavailable',
      currentVersion: app?.getVersion?.() ?? '0.0.0',
      availableVersion: null,
      progress: 0,
      message: app?.isPackaged ? '尚未检查更新' : '开发模式不检查更新'
    };
  }

  publicState() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    const state = this.publicState();
    for (const window of this.BrowserWindow?.getAllWindows?.() ?? []) {
      if (!window.isDestroyed?.()) window.webContents.send(UPDATE_CHANNEL, state);
    }
    return state;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.ipcMain.handle('updater:get-state', () => this.publicState());
    this.ipcMain.handle('updater:check', () => this.check());
    this.ipcMain.handle('updater:download', () => this.download());
    this.ipcMain.handle('updater:install', () => this.install());

    if (!this.app.isPackaged || !this.autoUpdater) return;
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = true;
    this.autoUpdater.on('checking-for-update', () => {
      this.setState({ status: 'checking', progress: 0, message: '正在检查启动器更新…' });
    });
    this.autoUpdater.on('update-available', (info) => {
      this.setState({
        status: 'available',
        availableVersion: info?.version ?? null,
        progress: 0,
        message: `发现新版本 ${info?.version ?? ''}`.trim()
      });
    });
    this.autoUpdater.on('update-not-available', () => {
      this.setState({
        status: 'current',
        availableVersion: null,
        progress: 100,
        message: `已是最新版本 ${this.state.currentVersion}`
      });
    });
    this.autoUpdater.on('download-progress', (progress) => {
      const downloaded = percent(progress?.percent);
      this.setState({
        status: 'downloading',
        progress: downloaded,
        message: `正在下载更新 ${downloaded}%`
      });
    });
    this.autoUpdater.on('update-downloaded', (info) => {
      this.setState({
        status: 'downloaded',
        availableVersion: info?.version ?? this.state.availableVersion,
        progress: 100,
        message: '更新已下载，重启后即可安装'
      });
    });
    this.autoUpdater.on('error', (error) => {
      this.setState({ status: 'error', message: `更新失败：${error?.message ?? String(error)}` });
    });
  }

  async check() {
    if (!this.app.isPackaged || !this.autoUpdater) return this.publicState();
    if (['checking', 'downloading'].includes(this.state.status)) return this.publicState();
    this.setState({ status: 'checking', progress: 0, message: '正在检查启动器更新…' });
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      this.setState({ status: 'error', message: `更新检查失败：${error?.message ?? String(error)}` });
    }
    return this.publicState();
  }

  async download() {
    if (!this.app.isPackaged || !this.autoUpdater) return this.publicState();
    if (this.state.status !== 'available') throw new Error('当前没有可下载的启动器更新');
    this.setState({ status: 'downloading', progress: 0, message: '正在下载更新 0%' });
    try {
      await this.autoUpdater.downloadUpdate();
    } catch (error) {
      this.setState({ status: 'error', message: `更新下载失败：${error?.message ?? String(error)}` });
    }
    return this.publicState();
  }

  install() {
    if (this.state.status !== 'downloaded') throw new Error('更新尚未下载完成');
    this.autoUpdater.quitAndInstall(false, true);
    return { installing: true };
  }
}

module.exports = { UPDATE_CHANNEL, UpdateManager, percent };
