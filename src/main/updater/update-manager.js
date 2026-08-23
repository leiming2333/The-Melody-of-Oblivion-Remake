const fs = require('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');

const UPDATE_CHANNEL = 'updater:state';
const LATEST_RELEASE_URL = 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest';
const PLATFORM_KEYWORDS = Object.freeze({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' });
const USER_AGENT = 'melody-of-oblivion-launcher-updater';

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function normalizeVersion(value) {
  const parts = String(value ?? '').trim().replace(/^v/i, '').split('.');
  const numbers = [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    const number = Number(parts[index]);
    numbers[index] = Number.isFinite(number) ? number : 0;
  }
  return numbers;
}

function isNewerVersion(candidate, current) {
  const a = normalizeVersion(candidate);
  const b = normalizeVersion(current);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

function pickAsset(assets, platform, arch) {
  const keyword = PLATFORM_KEYWORDS[platform];
  if (!keyword) return null;
  const candidates = (Array.isArray(assets) ? assets : []).filter((asset) => (
    typeof asset?.name === 'string'
    && typeof asset?.browser_download_url === 'string'
    && asset.name.includes(keyword)
  ));
  if (candidates.length === 0) return null;
  const archKeywords = arch === 'arm' ? ['armv7l', 'arm'] : [arch];
  for (const archKeyword of archKeywords) {
    const hit = candidates.find((asset) => (
      asset.name.toLowerCase().includes(String(archKeyword).toLowerCase())
    ));
    if (hit) return hit;
  }
  return candidates[0];
}

function errorMessage(error) {
  return error?.message ?? String(error);
}

function errorCode(error) {
  return error?.code ?? error?.cause?.code ?? null;
}

function isNetworkError(error) {
  const code = errorCode(error);
  if (code && ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH'].includes(code)) {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return message.includes('fetch failed') || message.includes('network') || message.includes('socket hang up');
}

function formatBytes(bytes) {
  const value = typeof bytes === 'bigint' ? bytes : BigInt(Math.max(0, Number(bytes) || 0));
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = value;
  let unitIndex = 0;
  while (current >= 1024n && unitIndex < units.length - 1) {
    current /= 1024n;
    unitIndex += 1;
  }
  return `${current}${units[unitIndex]}`;
}

function parseSha256(text) {
  const match = String(text ?? '').match(/[a-f0-9]{64}/i);
  return match ? match[0].toLowerCase() : null;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function downloadToFile(url, targetPath, onProgress) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok || !response.body) {
    throw new Error(`下载更新失败（HTTP ${response.status}）`);
  }
  const total = Number(response.headers.get('content-length')) || 0;
  let loaded = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    loaded += chunk.length;
    onProgress?.(total > 0 ? (loaded / total) * 100 : 0);
  });
  await pipeline(source, createWriteStream(targetPath));
  return targetPath;
}

class UpdateManager {
  constructor({
    app,
    BrowserWindow,
    ipcMain,
    fetchImpl = globalThis.fetch,
    downloadFile = downloadToFile,
    fileSystem = fs,
    spawnProcess = spawn,
    shell = null,
    onUpdateAvailable = null,
    platform = process.platform,
    arch = process.arch,
    env = process.env
  } = {}) {
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.ipcMain = ipcMain;
    this.fetchImpl = fetchImpl;
    this.downloadFile = downloadFile;
    this.fileSystem = fileSystem;
    this.spawnProcess = spawnProcess;
    this.shell = shell;
    this.onUpdateAvailable = onUpdateAvailable;
    this.platform = platform;
    this.arch = arch;
    this.env = env;
    this.started = false;
    this.release = null;
    this.updateFilePath = null;
    this.state = {
      status: app?.isPackaged ? 'idle' : 'unavailable',
      currentVersion: app?.getVersion?.() ?? '0.0.0',
      availableVersion: null,
      progress: 0,
      installAction: null,
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
  }

  async fetchLatestRelease() {
    const response = await this.fetchImpl(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT }
    });
    if (!response.ok) throw new Error(`获取 Release 信息失败（HTTP ${response.status}）`);
    return response.json();
  }

  async fetchText(url) {
    const response = await this.fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`下载校验文件失败（HTTP ${response.status}）`);
    return response.text();
  }

  getUpdateDirectory() {
    if (this.platform === 'win32') {
      return this.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
    }
    if (this.platform === 'linux') {
      return this.env.APPIMAGE ? path.dirname(this.env.APPIMAGE) : path.dirname(process.execPath);
    }
    return this.app.getPath('downloads');
  }

  async assertEnoughStorage(directory, size) {
    if (!this.fileSystem.statfs) return;
    const required = BigInt(Math.max(0, Number(size) || 0)) + 64n * 1024n * 1024n;
    const stats = await this.fileSystem.statfs(directory, { bigint: true });
    const available = stats.bavail * stats.bsize;
    if (available < required) {
      const error = new Error(`存储空间不足，无法下载更新（可用 ${formatBytes(available)}，需要 ${formatBytes(required)}）`);
      error.code = 'ENOSPC';
      throw error;
    }
  }

  checksumAssetFor(updateAsset) {
    const name = String(updateAsset?.name ?? '');
    const candidates = [
      `${name}.sha256`,
      `${name}.sha256.txt`,
      `${name}.sha256sum`,
      `${name}.sha256sum.txt`
    ].map((candidate) => candidate.toLowerCase());
    const assets = Array.isArray(this.release?.assets) ? this.release.assets : [];
    return assets.find((asset) => (
      typeof asset?.name === 'string'
      && candidates.includes(asset.name.toLowerCase())
      && typeof asset?.browser_download_url === 'string'
    )) ?? null;
  }

  async verifyDownloadedFile(updateAsset, filePath) {
    const expectedSize = Number(updateAsset?.size) || 0;
    if (this.fileSystem.stat && expectedSize > 0) {
      const stat = await this.fileSystem.stat(filePath);
      const actual = Number(stat?.size) || 0;
      if (actual !== expectedSize) throw new Error(`更新包校验失败：文件大小不匹配（期望 ${formatBytes(expectedSize)}，实际 ${formatBytes(actual)}）`);
    }

    const checksumAsset = this.checksumAssetFor(updateAsset);
    if (!checksumAsset) return;

    const checksumText = await this.fetchText(checksumAsset.browser_download_url);
    const expectedSha256 = parseSha256(checksumText);
    if (!expectedSha256) throw new Error('更新包校验失败：校验文件内容无效');
    const actualSha256 = await sha256File(filePath);
    if (expectedSha256 !== actualSha256) throw new Error('更新包校验失败：SHA-256 不匹配，请重试下载');
  }

  async check({ autoDownload = true } = {}) {
    if (!this.app.isPackaged) {
      return this.setState({ status: 'unavailable', message: '开发模式不检查更新' });
    }
    if (['checking', 'downloading'].includes(this.state.status)) return this.publicState();
    this.setState({ status: 'checking', progress: 0, message: '正在检查启动器更新…' });
    try {
      const release = await this.fetchLatestRelease();
      const latest = String(release?.tag_name ?? '').trim();
      if (!latest) throw new Error('Release 信息缺少版本标签');
      this.release = release;
      if (!isNewerVersion(latest, this.state.currentVersion)) {
        this.setState({
          status: 'current',
          availableVersion: null,
          progress: 100,
          message: `已是最新版本 ${this.state.currentVersion}`
        });
      } else {
        const version = latest.replace(/^v/i, '');
        this.setState({
          status: 'available',
          availableVersion: version,
          progress: 0,
          message: `发现新版本 ${version}`
        });
        this.onUpdateAvailable?.(version, release?.html_url ?? null);
        if (autoDownload) await this.download();
      }
    } catch (error) {
      const message = isNetworkError(error)
        ? '网络异常，无法检查更新，请检查网络连接'
        : `更新检查失败：${errorMessage(error)}`;
      this.setState({ status: 'error', message });
    }
    return this.publicState();
  }

  async download() {
    if (!this.app.isPackaged) return this.publicState();
    if (this.state.status === 'downloading') return this.publicState();
    if (this.state.status !== 'available') throw new Error('当前没有可下载的启动器更新');
    const asset = pickAsset(this.release?.assets, this.platform, this.arch);
    if (!asset) throw new Error('Release 中未找到适合当前系统的更新文件');
    const directory = this.getUpdateDirectory();
    const targetPath = path.join(directory, asset.name);
    this.setState({ status: 'downloading', progress: 0, message: '正在后台下载更新 0%' });
    try {
      await this.fileSystem.mkdir(directory, { recursive: true });
      await this.assertEnoughStorage(directory, asset.size);
      await this.downloadFile(asset.browser_download_url, targetPath, (value) => {
        const downloaded = percent(value);
        this.setState({
          status: 'downloading',
          progress: downloaded,
          message: `正在后台下载更新 ${downloaded}%`
        });
      });
      this.setState({ status: 'verifying', progress: 100, message: '正在校验更新包…' });
      await this.verifyDownloadedFile(asset, targetPath);
      this.updateFilePath = await this.finalizeDownload(targetPath);
      this.setState({
        status: 'downloaded',
        progress: 100,
        installAction: this.platform === 'darwin' ? 'open-folder' : 'relaunch',
        message: this.platform === 'darwin'
          ? '新版本已下载，请解压压缩包并替换旧版本'
          : '新版本已就绪，重启启动器即可完成更新'
      });
    } catch (error) {
      const code = errorCode(error);
      const message = String(errorMessage(error));
      const friendly = message.startsWith('更新包校验失败')
        ? message
        : code === 'ENOSPC'
          ? '存储空间不足，无法下载更新'
          : ['EACCES', 'EPERM', 'EROFS'].includes(code)
            ? '没有写入权限，无法保存更新文件'
            : isNetworkError(error)
              ? '网络异常，无法下载更新，请检查网络连接'
              : message.startsWith('下载更新失败')
                ? message
                : `更新下载失败：${message}`;
      this.setState({ status: 'error', message: friendly });
    }
    return this.publicState();
  }

  async finalizeDownload(targetPath) {
    if (this.platform !== 'linux') return targetPath;
    await this.fileSystem.chmod(targetPath, 0o755);
    const currentAppImage = this.env.APPIMAGE;
    if (!currentAppImage) return targetPath;
    const backupPath = `${currentAppImage}.old`;
    await this.fileSystem.rm?.(backupPath, { force: true });
    await this.fileSystem.rename(currentAppImage, backupPath);
    await this.fileSystem.rename(targetPath, currentAppImage);
    return currentAppImage;
  }

  async install() {
    if (this.state.status !== 'downloaded') throw new Error('更新尚未下载完成');
    if (!this.updateFilePath) throw new Error('更新文件路径无效，请重新下载更新');
    if (this.fileSystem.stat) await this.fileSystem.stat(this.updateFilePath);
    if (this.state.installAction === 'open-folder') {
      this.shell?.showItemInFolder?.(this.updateFilePath);
      return { installing: true };
    }
    if (this.platform === 'win32') {
      const child = this.spawnProcess(this.updateFilePath, [], { detached: true, stdio: 'ignore' });
      child?.unref?.();
    } else {
      this.app.relaunch?.();
    }
    this.app.quit?.();
    return { installing: true };
  }
}

module.exports = {
  UPDATE_CHANNEL,
  UpdateManager,
  downloadToFile,
  isNewerVersion,
  normalizeVersion,
  percent,
  pickAsset
};
