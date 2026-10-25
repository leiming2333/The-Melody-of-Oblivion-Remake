const fs = require('node:fs/promises');
const { createWriteStream, createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { constants: fsConstants } = require('node:fs');
const { isPublicBlobUrl, isStableRelease, withBlobDownloads } = require('../../shared/release-metadata');
const { TransactionStore, identity, transactionPaths, assertManagedAncestors } = require('./transaction-store');
const { startInstallHelper, startWindowsHelper } = require('./install-helper');

const UPDATE_CHANNEL = 'updater:state';
const WEBSITE_ORIGIN = 'https://melodyoblivion.xyz';
const WEBSITE_RELEASE_URL = `${WEBSITE_ORIGIN}/api/latest-release`;
const LATEST_RELEASE_URL = 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest';
const PLATFORM_KEYWORDS = Object.freeze({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' });
const USER_AGENT = 'melody-of-oblivion-launcher-updater';

// 更新安装包优先使用 Blob，过慢或失败时切换 GitHub 镜像，最后回退官方源。
const GITHUB_MIRRORS = Object.freeze([
  'https://ghproxy.net',
  'https://gh-proxy.com',
  'https://ghfast.top',
  'https://github.moeyy.xyz'
]);
const API_TIMEOUT_MS = 15000;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 10000;
const DOWNLOAD_STALL_TIMEOUT_MS = 15000;
const DOWNLOAD_MIN_SPEED_BYTES_PER_SEC = 100 * 1024;
const DOWNLOAD_MIN_SPEED_GRACE_MS = 6000;
const DOWNLOAD_SPEED_WINDOW_MS = 3000;

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
  const extension = { win32: '.exe', darwin: '.zip', linux: '.AppImage' }[platform];
  const candidates = (Array.isArray(assets) ? assets : []).filter((asset) => (
    typeof asset?.name === 'string'
    && typeof asset?.browser_download_url === 'string'
    && asset.name.includes(keyword)
    && asset.name.endsWith(extension)
    && (platform !== 'win32' || !/-Windows-Setup-/i.test(asset.name))
    && !/[\\/\0\r\n<>:"|?*]/.test(asset.name)
  ));
  if (candidates.length === 0) return null;
  const archKeywords = arch === 'arm' ? ['armv7l', 'arm']
    : arch === 'x64' ? ['x64', 'x86_64'] : [arch];
  for (const archKeyword of archKeywords) {
    const hit = candidates.find((asset) => (
      asset.name.toLowerCase().endsWith(`-${archKeyword}${extension}`.toLowerCase())
    ));
    if (hit) return hit;
  }
  return null;
}

function isGithubUrl(url) {
  return /^https:\/\/(github\.com|api\.github\.com)\//i.test(String(url));
}

function mirrorUrls(url) {
  if (!isGithubUrl(url)) return [];
  return GITHUB_MIRRORS.map((prefix) => `${prefix}/${url}`);
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('启动器更新已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
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
  if (isAbortError(error)) return true;
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

async function sha256File(filePath, signal) {
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(filePath), hash, { signal });
  return hash.digest('hex');
}

async function downloadToFile(url, targetPath, onProgress, {
  enforceMinSpeed = true,
  connectTimeoutMs = DOWNLOAD_CONNECT_TIMEOUT_MS,
  stallTimeoutMs = DOWNLOAD_STALL_TIMEOUT_MS,
  signal
} = {}) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let connectionTimedOut = false;
  const connectTimer = setTimeout(() => {
    connectionTimedOut = true;
    controller.abort();
  }, connectTimeoutMs);
  const startedAt = Date.now();
  let loaded = 0;
  let windowStartedAt = startedAt;
  let windowLoadedBytes = 0;
  let lastByteAt = startedAt;
  let speedAborted = false;
  let stallAborted = false;
  let monitor = null;

  try {
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal });
    clearTimeout(connectTimer);
    if (!response.ok || !response.body) {
      throw new Error(`下载更新失败（HTTP ${response.status}）`);
    }
    const total = Number(response.headers.get('content-length')) || 0;
    const source = Readable.fromWeb(response.body);
    lastByteAt = Date.now();
    monitor = setInterval(() => {
      const now = Date.now();
      const windowBytes = loaded - windowLoadedBytes;
      if (now - lastByteAt >= stallTimeoutMs) {
        stallAborted = true;
        controller.abort();
        return;
      }
      const windowMs = now - windowStartedAt;
      if (windowMs < DOWNLOAD_SPEED_WINDOW_MS) return;
      const bytesPerSecond = (windowBytes * 1000) / windowMs;
      if (
        enforceMinSpeed
        && now - startedAt >= DOWNLOAD_MIN_SPEED_GRACE_MS
        && bytesPerSecond < DOWNLOAD_MIN_SPEED_BYTES_PER_SEC
      ) {
        speedAborted = true;
        controller.abort();
        return;
      }
      windowStartedAt = now;
      windowLoadedBytes = loaded;
    }, Math.min(1000, stallTimeoutMs));
    source.on('data', (chunk) => {
      loaded += chunk.length;
      lastByteAt = Date.now();
      onProgress?.(total > 0 ? (loaded / total) * 100 : 0);
    });
    await pipeline(source, createWriteStream(targetPath));
    return targetPath;
  } catch (error) {
    throwIfAborted(signal);
    if (speedAborted) {
      const slowError = new Error('当前下载源速度过慢');
      slowError.code = 'SLOW_SOURCE';
      throw slowError;
    }
    if (stallAborted) {
      const stallError = new Error('下载超时：服务器长时间未响应');
      stallError.code = 'STALL_SOURCE';
      throw stallError;
    }
    if (connectionTimedOut) {
      const timeoutError = new Error('连接下载源超时');
      timeoutError.code = 'CONNECT_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    clearTimeout(connectTimer);
    if (monitor) clearInterval(monitor);
  }
}

class UpdateManager {
  constructor({
    app,
    BrowserWindow,
    ipcMain,
    settingsStore = null,
    fetchImpl = globalThis.fetch,
    downloadFile = downloadToFile,
    fileSystem = fs,
    hashFile = sha256File,
    spawnProcess = spawn,
    runCommand = promisify(execFile),
    startHelper = startInstallHelper,
    installationTarget = null,
    shell = null,
    onUpdateAvailable = null,
    onUpdateReady = null,
    platform = process.platform,
    arch = process.arch,
    env = process.env
  } = {}) {
    this.app = app;
    this.BrowserWindow = BrowserWindow;
    this.ipcMain = ipcMain;
    this.settingsStore = settingsStore;
    this.fetchImpl = fetchImpl;
    this.downloadFile = downloadFile;
    this.fileSystem = fileSystem;
    this.hashFile = hashFile;
    this.spawnProcess = spawnProcess;
    this.runCommand = runCommand;
    this.startHelper = startHelper;
    this.installationTarget = installationTarget;
    this.shell = shell;
    this.onUpdateAvailable = onUpdateAvailable;
    this.onUpdateReady = onUpdateReady;
    this.platform = platform;
    this.arch = arch;
    this.env = env;
    this.started = false;
    this.release = null;
    this.updateFilePath = null;
    this.notifiedVersion = null;
    this.store = null;
    this.initialized = false;
    this.initializing = null;
    this.transaction = null;
    this.operation = null;
    this.operationPromise = null;
    this.historyCandidates = new Map();
    this.state = {
      platform,
      status: app?.isPackaged ? 'idle' : 'unavailable',
      currentVersion: app?.getVersion?.() ?? '0.0.0',
      availableVersion: null,
      releaseNotes: null,
      progress: 0,
      installAction: null,
      canCancel: false,
      recovery: null,
      manualInstallReason: null,
      rollbackAvailable: false,
      rollbackVersion: null,
      message: app?.isPackaged ? '尚未检查更新' : '开发模式不检查更新'
    };
  }

  publicState() {
    return { ...this.state, recovery: this.state.recovery ? { ...this.state.recovery,
      actions: [...this.state.recovery.actions] } : null };
  }

  getInstallationTarget() {
    if (this.installationTarget) return path.resolve(this.installationTarget);
    if (this.platform === 'win32') return this.env.PORTABLE_EXECUTABLE_FILE ? path.resolve(this.env.PORTABLE_EXECUTABLE_FILE) : null;
    if (this.platform === 'linux') return this.env.APPIMAGE ? path.resolve(this.env.APPIMAGE) : null;
    if (this.platform === 'darwin') {
      const executable = this.app.getPath?.('exe');
      if (executable && path.basename(path.dirname(executable)) === 'MacOS'
        && path.basename(path.dirname(path.dirname(executable))) === 'Contents') {
        const bundle = path.resolve(executable, '..', '..', '..');
        if (bundle.endsWith('.app')) return bundle;
      }
    }
    return null;
  }

  ensureStore() {
    const target = this.getInstallationTarget();
    if (!target) return null;
    if (!this.store || identity(this.store.target, this.platform) !== identity(target, this.platform)) {
      this.store = new TransactionStore({ directory: path.join(this.app.getPath('userData'), 'updates'),
        target, platform: this.platform, fileSystem: this.fileSystem });
    }
    return this.store;
  }

  async initialize() {
    if (this.initialized) return this.publicState();
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      try {
        const store = this.ensureStore();
        if (!store) { this.initialized = true; return this.publicState(); }
        await store.load();
        const record = store.latest();
        if (record?.phase === 'confirmed') {
          const backup = await this.fileSystem.lstat?.(record.backupPath).catch(() => null);
          this.setState({ rollbackAvailable: Boolean(backup && !backup.isSymbolicLink()), rollbackVersion: record.fromVersion });
        }
        if (record && !['confirmed', 'rolled-back', 'abandoned'].includes(record.phase)) {
          this.transaction = record;
          this.updateFilePath = record.downloadPath || record.sourcePath;
          this.setState({ status: record.phase === 'prepared' ? 'downloaded' : 'error',
            availableVersion: record.toVersion, progress: record.phase === 'prepared' ? 100 : 0,
            installAction: 'relaunch', recovery: this.recoveryFor(record),
            message: record.phase === 'prepared' ? '已保留上次下载的更新，可继续安装' : '上次更新尚未确认完成，请选择恢复操作' });
        }
        this.initialized = true;
      } catch (error) {
        this.setState({ status: 'error', errorCode: 'UPDATE_RECOVERY_INVALID', message: error.message,
          recovery: null, canCancel: false });
        throw error;
      }
      return this.publicState();
    })().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  recoveryFor(record) {
    return { transactionId: record.id, phase: record.phase,
      actions: record.phase === 'prepared' ? ['retry', 'keep-current']
        : record.phase === 'awaiting-health' ? ['rollback', 'keep-current'] : ['retry', 'rollback', 'keep-current'],
      message: record.error || '更新尚未确认完成，备份与更新包已保留' };
  }

  async withOperation(runner) {
    if (this.operationPromise) return this.operationPromise;
    const controller = new AbortController();
    this.operation = controller;
    this.setState({ canCancel: true, errorCode: null });
    this.operationPromise = (async () => {
      let result;
      try { result = await runner(controller.signal); }
      finally {
        if (this.operation === controller) {
          this.operation = null;
          this.operationPromise = null;
          this.setState({ canCancel: false });
        }
      }
      return result?.status ? this.publicState() : result;
    })();
    return this.operationPromise;
  }

  async cancel() {
    if (!this.operation || !this.state.canCancel) return this.publicState();
    this.operation.abort();
    await this.operationPromise;
    return this.publicState();
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
    require('./ipc').registerUpdateIpc({ ipcMain: this.ipcMain, getUpdateManager: () => this });
  }

  async fetchLatestRelease() {
    const candidates = [WEBSITE_RELEASE_URL, LATEST_RELEASE_URL, ...mirrorUrls(LATEST_RELEASE_URL)];
    let websiteRelease = null;
    let lastError = null;
    for (const url of candidates) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(API_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`获取 Release 信息失败（HTTP ${response.status}）`);
        const release = await response.json();
        if (!isStableRelease(release)) throw new Error('Release 信息无效');
        if (url === WEBSITE_RELEASE_URL) {
          websiteRelease = release;
          continue;
        }
        if (websiteRelease && isNewerVersion(websiteRelease.tag_name, release.tag_name)) {
          throw new Error('发布源返回了较旧版本，继续核对最新版本');
        }
        return withBlobDownloads(release, websiteRelease);
      } catch (error) {
        lastError = error;
      }
    }
    // A cached release can prove an update exists, but cannot prove we are current.
    if (websiteRelease && isNewerVersion(websiteRelease.tag_name, this.state.currentVersion)) {
      return websiteRelease;
    }
    throw lastError ?? new Error('获取 Release 信息失败');
  }

  async fetchText(url, signal) {
    const candidates = [url, ...mirrorUrls(url)];
    let lastError = null;
    for (const candidate of candidates) {
      throwIfAborted(signal);
      try {
        const response = await this.fetchImpl(candidate, {
          headers: { 'User-Agent': USER_AGENT },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)]) : AbortSignal.timeout(API_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`下载校验文件失败（HTTP ${response.status}）`);
        return await response.text();
      } catch (error) {
        throwIfAborted(signal);
        lastError = error;
      }
    }
    throw lastError ?? new Error('下载校验文件失败');
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

  async verifyDownloadedFile(updateAsset, filePath, signal) {
    throwIfAborted(signal);
    const expectedSize = Number(updateAsset?.size) || 0;
    if (this.fileSystem.stat && expectedSize > 0) {
      const stat = await this.fileSystem.stat(filePath);
      const actual = Number(stat?.size) || 0;
      if (actual !== expectedSize) throw new Error(`更新包校验失败：文件大小不匹配（期望 ${formatBytes(expectedSize)}，实际 ${formatBytes(actual)}）`);
    }

    let expectedSha256 = /^sha256:([a-f0-9]{64})$/i.exec(String(updateAsset?.digest ?? ''))?.[1]?.toLowerCase();
    if (!expectedSha256) {
      const checksumAsset = this.checksumAssetFor(updateAsset);
      if (!checksumAsset) throw new Error('更新包校验失败：发布版本缺少 SHA-256 校验信息，请从发布页手动下载');
      expectedSha256 = parseSha256(await this.fetchText(checksumAsset.browser_download_url, signal));
    }
    if (!expectedSha256) throw new Error('更新包校验失败：校验文件内容无效');
    const actualSha256 = await this.hashFile(filePath, signal);
    throwIfAborted(signal);
    if (expectedSha256 !== actualSha256) throw new Error('更新包校验失败：SHA-256 不匹配，请重试下载');
    return actualSha256;
  }

  async check({ autoDownload = true } = {}) {
    if (!this.app.isPackaged) {
      return this.setState({ status: 'unavailable', message: '开发模式不检查更新' });
    }
    await this.initialize();
    if (this.state.recovery || ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(this.state.status)) return this.publicState();
    this.setState({ status: 'checking', progress: 0, message: '正在检查启动器更新…' });
    try {
      const release = await this.fetchLatestRelease();
      const latest = String(release?.tag_name ?? '').trim();
      if (!latest) throw new Error('Release 信息缺少版本标签');
      this.release = release;
      if (isNewerVersion(this.state.currentVersion, latest)) {
        throw new Error('发布源返回了较旧版本，无法确认最新版本，请稍后重试');
      }
      if (!isNewerVersion(latest, this.state.currentVersion)) {
        this.setState({
          status: 'current',
          availableVersion: null,
          releaseNotes: null,
          progress: 100,
          message: `已是最新版本 ${this.state.currentVersion}`
        });
      } else {
        const version = latest.replace(/^v/i, '');
        this.setState({
          status: 'available',
          availableVersion: version,
          releaseNotes: this.sanitizeReleaseNotes(release?.body),
          progress: 0,
          message: `发现新版本 ${version}`
        });
        if (this.notifiedVersion !== version) {
          this.notifiedVersion = version;
          this.onUpdateAvailable?.(version, release?.html_url ?? null, autoDownload);
        }
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

  // Release 正文仅保留安全子集，避免渲染层引入 HTML 注入风险
  sanitizeReleaseNotes(body) {
    const text = String(body ?? '').trim();
    if (!text) return null;
    const limited = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    return limited.replace(/\u0000/g, '');
  }

  downloadCandidates(assetUrl, assetName, githubDownloadUrl = null) {
    const blob = isPublicBlobUrl(assetUrl);
    if (!blob && !isGithubUrl(assetUrl)) return [{ url: assetUrl, enforceMinSpeed: false }];
    const tag = this.release?.tag_name ?? '';
    const githubUrl = blob
      ? isGithubUrl(githubDownloadUrl)
        ? githubDownloadUrl
        : `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
      : assetUrl;
    const websiteUrl = new URL('/api/download', WEBSITE_ORIGIN);
    websiteUrl.searchParams.set('tag', tag);
    websiteUrl.searchParams.set('asset', assetName);
    websiteUrl.searchParams.set('source', 'blob');
    return [
      { url: blob ? assetUrl : websiteUrl.href, enforceMinSpeed: true },
      ...mirrorUrls(githubUrl).map((url) => ({ url, enforceMinSpeed: true })),
      { url: githubUrl, enforceMinSpeed: true },
      // 所有镜像均不可用时，最后回退官方直连并放宽限速
      { url: githubUrl, enforceMinSpeed: false }
    ];
  }

  async downloadUpdateFile(assetUrl, assetName, targetPath, onProgress, githubDownloadUrl = null, signal) {
    const candidates = this.downloadCandidates(assetUrl, assetName, githubDownloadUrl);
    let lastError = null;
    for (const candidate of candidates) {
      throwIfAborted(signal);
      try {
        await this.downloadFile(candidate.url, targetPath, onProgress, {
          enforceMinSpeed: candidate.enforceMinSpeed, signal
        });
        return candidate.url;
      } catch (error) {
        throwIfAborted(signal);
        if (isAbortError(error)) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error('下载更新失败');
  }

  async download() {
    if (!this.app.isPackaged) return this.publicState();
    if (this.operationPromise) return this.publicState();
    if (this.state.status !== 'available') throw new Error('当前没有可下载的启动器更新');
    const asset = pickAsset(this.release?.assets, this.platform, this.arch);
    if (!asset) throw new Error('Release 中未找到适合当前系统的更新文件');
    return this.withOperation((signal) => this.performDownload(asset, signal));
  }

  async performDownload(asset, signal) {
    let directory = this.getUpdateDirectory();
    const store = this.ensureStore();
    const id = crypto.randomUUID();
    let record = null;
    if (store) {
      const managed = transactionPaths(store.target, id, this.platform);
      directory = this.platform === 'darwin'
        ? path.join(path.dirname(store.filePath), 'packages', id) : managed.stagingRoot;
      record = { id, platform: this.platform, arch: this.arch, fromVersion: this.state.currentVersion,
        toVersion: this.state.availableVersion, targetPath: store.target, ...managed,
        phase: 'prepared', createdAt: new Date().toISOString(), error: '' };
    }
    const targetPath = path.join(directory, asset.name);
    const temporaryPath = `${targetPath}.part`;
    this.setState({ status: 'downloading', progress: 0, manualInstallReason: null,
      recovery: null, message: '正在后台下载更新 0%' });
    try {
      if (store) await assertManagedAncestors(this.fileSystem, directory, this.platform === 'darwin'
        ? path.dirname(store.filePath) : path.dirname(store.target));
      await this.fileSystem.mkdir(directory, { recursive: true });
      await this.assertEnoughStorage(directory, asset.size);
      throwIfAborted(signal);
      await this.downloadUpdateFile(asset.browser_download_url, asset.name, temporaryPath, (value) => {
        if (signal.aborted) return;
        const downloaded = percent(value);
        this.setState({
          status: 'downloading',
          progress: downloaded,
          message: `正在后台下载更新 ${downloaded}%`
        });
      }, asset.github_download_url, signal);
      this.setState({ status: 'verifying', progress: 100, message: '正在校验更新包…' });
      const sha256 = await this.verifyDownloadedFile(asset, temporaryPath, signal);
      throwIfAborted(signal);
      await this.fileSystem.rename(temporaryPath, targetPath);
      this.updateFilePath = targetPath;
      this.downloadedSha256 = sha256;
      if (this.platform === 'linux') await this.fileSystem.chmod(targetPath, 0o755);
      if (record) {
        record = { ...record, sourcePath: targetPath, downloadPath: targetPath, sha256 };
        await store.save(record);
        this.transaction = record;
      }
      throwIfAborted(signal);
      this.setState({
        status: 'downloaded',
        progress: 100,
        installAction: this.platform === 'darwin' && !record ? 'open-folder' : 'relaunch',
        message: this.platform === 'darwin' && !record
          ? '新版本已下载，请解压压缩包并替换旧版本'
          : '新版本已就绪，重启启动器即可完成更新'
      });
      this.onUpdateReady?.(this.state.availableVersion, this.state.installAction);
    } catch (error) {
      await this.fileSystem.rm?.(temporaryPath, { force: true }).catch(() => {});
      if (signal.aborted || isAbortError(error)) {
        if (record?.sha256) {
          this.setState({ status: 'downloaded', progress: 100, installAction: 'relaunch', message: '更新已就绪，安装准备已取消' });
        } else {
          this.setState({ status: 'available', progress: 0, message: '更新下载已取消，可重新下载' });
        }
        return this.publicState();
      }
      const code = errorCode(error);
      const message = String(errorMessage(error));
      const friendly = message.startsWith('更新包校验失败')
        ? message
        : code === 'ENOSPC'
          ? '存储空间不足，无法下载更新'
          : ['EACCES', 'EPERM', 'EROFS'].includes(code)
            ? '没有写入权限，无法保存更新文件'
            : ['SLOW_SOURCE', 'STALL_SOURCE', 'CONNECT_TIMEOUT'].includes(code)
              ? '所有下载源均不可用或速度过慢，请检查网络后重试'
              : isNetworkError(error)
                ? '网络异常，无法下载更新，请检查网络连接'
                : message.startsWith('下载更新失败')
                  ? message
                  : `更新下载失败：${message}`;
      this.setState({ status: 'error', errorCode: code || 'UPDATE_DOWNLOAD_FAILED', message: friendly });
    }
    return this.publicState();
  }

  async finalizeDownload(targetPath) {
    if (this.platform !== 'linux') return targetPath;
    await this.fileSystem.chmod(targetPath, 0o755);
    const currentAppImage = this.env.APPIMAGE;
    if (!currentAppImage) return targetPath;
    if (path.resolve(targetPath) === path.resolve(currentAppImage)) {
      throw new Error('更新包必须位于独立暂存路径');
    }
    const backupPath = `${currentAppImage}.old`;
    let preservedBackup = backupPath;
    try {
      await this.fileSystem.copyFile(currentAppImage, preservedBackup, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      preservedBackup = `${backupPath}-${crypto.randomUUID()}`;
      await this.fileSystem.copyFile(currentAppImage, preservedBackup, fsConstants.COPYFILE_EXCL);
    }
    // Linux rename atomically replaces the pathname; failure leaves the old executable intact.
    // Keep the backup and the verified staged package if committing fails.
    await this.fileSystem.rename(targetPath, currentAppImage);
    return currentAppImage;
  }

  async install() {
    if (this.operationPromise) return this.publicState();
    if (this.state.status !== 'downloaded') throw new Error('更新尚未下载完成');
    if (!this.updateFilePath) throw new Error('更新文件路径无效，请重新下载更新');
    if (this.state.installAction === 'open-folder') {
      this.shell?.showItemInFolder?.(this.updateFilePath);
      return { installing: true };
    }
    return this.withOperation((signal) => this.performInstall(signal));
  }

  async performInstall(signal, { rollback = false } = {}) {
    const record = this.transaction;
    let child = null;
    this.setState({ status: 'preparing', message: rollback ? '正在准备恢复上一版本…' : '正在准备安装更新…' });
    try {
      throwIfAborted(signal);
      if (!record) {
        await this.fileSystem.stat?.(this.updateFilePath);
        if (this.downloadedSha256 && await this.hashFile(this.updateFilePath, signal) !== this.downloadedSha256) {
          throw new Error('更新包校验失败：安装前 SHA-256 不匹配');
        }
        if (this.platform === 'win32') {
          const { launchScript } = require('./windows-replacement');
          child = await startWindowsHelper({ directory: path.dirname(this.updateFilePath), fileSystem: this.fileSystem,
            spawnProcess: this.spawnProcess, signal, makeScript: (options) => launchScript(this.updateFilePath, process.pid, options) });
        } else this.app.relaunch?.();
      } else {
        if (!this.store.valid(record)) throw new Error('更新恢复路径无效');
        await assertManagedAncestors(this.fileSystem, record.targetPath, path.dirname(record.targetPath));
        const targetStat = await this.fileSystem.lstat?.(record.targetPath);
        if (targetStat?.isSymbolicLink()) throw new Error('当前启动器路径不能是符号链接');
        if (this.platform !== 'darwin') record.backupSha256 = await this.hashFile(record.targetPath, signal);
        const packagePath = rollback ? record.sourcePath : (record.downloadPath || record.sourcePath);
        await assertManagedAncestors(this.fileSystem, packagePath, this.platform === 'darwin' && !record.rollbackOf
          ? path.dirname(this.store.filePath) : path.dirname(record.targetPath));
        const file = await this.fileSystem.lstat?.(packagePath);
        if (file?.isSymbolicLink()) throw new Error('更新文件不能是符号链接');
        if (!rollback && await this.hashFile(packagePath, signal) !== record.sha256) throw new Error('更新包校验失败：安装前 SHA-256 不匹配');
        throwIfAborted(signal);
        if (this.platform === 'darwin' && !rollback) {
          const { prepareMacUpdate } = require('./macos-preparation');
          record.sourcePath = await prepareMacUpdate({ record, fileSystem: this.fileSystem,
            runCommand: this.runCommand, arch: this.arch, signal });
          await this.store.save(record);
        }
        throwIfAborted(signal);
        await this.store.save(record);
        if (this.platform === 'linux') {
          this.setState({ canCancel: false, status: 'installing', message: '正在替换启动器…' });
          record.phase = 'applying';
          await this.store.save(record);
          await this.fileSystem.copyFile(record.targetPath, record.backupPath, fsConstants.COPYFILE_EXCL);
          try { await this.fileSystem.rename(record.sourcePath, record.targetPath); }
          catch (error) { record.phase = 'failed'; record.error = error.message; await this.store.save(record); throw error; }
          record.phase = rollback ? 'rolled-back' : 'awaiting-health';
          await this.store.save(record);
          this.updateFilePath = record.targetPath;
          this.app.relaunch?.();
        } else {
          child = await this.startHelper({ record, store: this.store, platform: this.platform,
            spawnProcess: this.spawnProcess, signal, rollback });
        }
      }
      throwIfAborted(signal);
      this.setState({ status: 'installing', canCancel: false, message: rollback ? '正在恢复上一版本…' : '正在退出并安装更新…' });
      this.app.quit?.();
      return { installing: true };
    } catch (error) {
      child?.kill?.();
      if (signal.aborted || isAbortError(error)) {
        this.setState({ status: 'downloaded', canCancel: false, message: '更新安装准备已取消，可稍后继续' });
      } else if (error.code === 'MANUAL_INSTALL_REQUIRED') {
        this.setState({ status: 'downloaded', installAction: 'open-folder', canCancel: false,
          manualInstallReason: error.message, message: error.message });
      } else {
        if (record && !['applying', 'awaiting-health', 'rolled-back'].includes(record.phase)) {
          record.phase = 'failed'; record.error = error.message;
          await this.store.save(record).catch(() => {});
        }
        this.setState({ status: 'error', canCancel: false, errorCode: error.code || 'UPDATE_INSTALL_FAILED',
          message: `更新安装失败：${error.message}`, recovery: record ? this.recoveryFor(record) : null });
      }
      return this.publicState();
    }
  }

  async confirmHealthy() {
    if (!this.app.isPackaged) return this.publicState();
    await this.initialize();
    const store = this.ensureStore();
    if (!store) return this.publicState();
    await store.load();
    const record = store.latest();
    if (!record || !['awaiting-health', 'confirmed'].includes(record.phase)
      || record.toVersion !== this.state.currentVersion || record.arch !== this.arch
      || identity(record.targetPath, this.platform) !== identity(this.getInstallationTarget(), this.platform)) return this.publicState();
    if (this.platform !== 'darwin' && await this.hashFile(record.targetPath) !== record.sha256) {
      return this.setState({ status: 'error', recovery: this.recoveryFor(record), message: '当前启动器文件与更新记录不符，已保留恢复备份' });
    }
    record.phase = 'confirmed'; record.confirmedAt = new Date().toISOString(); record.error = '';
    await store.save(record);
    this.transaction = null;
    this.updateFilePath = null;
    this.setState({ status: 'current', recovery: null, availableVersion: null, installAction: null,
      rollbackAvailable: true, rollbackVersion: record.fromVersion,
      message: `已完成更新 ${this.state.currentVersion}` });
    await this.cleanupConfirmed(store, record);
    return this.publicState();
  }

  async removeOwned(targetPath, { recursive = false } = {}) {
    if (!this.fileSystem.lstat) return;
    const inspect = async (entryPath) => {
      const stat = await this.fileSystem.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        if (this.platform !== 'darwin') throw new Error('受管路径包含符号链接，已跳过清理');
        const root = await this.fileSystem.realpath(targetPath);
        const resolved = await this.fileSystem.realpath(entryPath);
        if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('受管路径包含外部链接');
        return;
      }
      if (stat.isDirectory()) {
        for (const entry of await this.fileSystem.readdir(entryPath)) await inspect(path.join(entryPath, entry));
      }
    };
    try {
      // Also refuse an ancestor junction redirecting an otherwise ordinary child.
      let parent = path.dirname(targetPath);
      const stop = path.dirname(this.store.target);
      while (parent !== path.dirname(parent)) {
        const stat = await this.fileSystem.lstat(parent);
        if (stat.isSymbolicLink()) return;
        if (identity(parent, this.platform) === identity(stop, this.platform)) break;
        parent = path.dirname(parent);
      }
      await inspect(targetPath);
      await this.fileSystem.rm(targetPath, { recursive, force: true });
    } catch {
      // Locked or unrecognized paths are retried after a later healthy startup.
    }
  }

  async cleanupConfirmed(store, current) {
    for (const record of store.records) {
      if (!store.valid(record) || !['confirmed', 'rolled-back', 'abandoned', 'failed'].includes(record.phase)) continue;
      if (record.id !== current.id) {
        let unchanged = this.platform === 'darwin';
        if (!unchanged && record.backupSha256) {
          unchanged = await this.hashFile(record.backupPath).then((hash) => hash === record.backupSha256, () => false);
        }
        if (unchanged) await this.removeOwned(record.backupPath, { recursive: this.platform === 'darwin' });
      }
      await this.removeOwned(record.stagingRoot, { recursive: true });
      if (this.platform === 'darwin' && record.downloadPath) await this.removeOwned(path.dirname(record.downloadPath), { recursive: true });
    }
  }

  async recover(action) {
    await this.initialize();
    if (this.operationPromise) return this.publicState();
    const store = this.ensureStore();
    if (!store) throw new Error('当前安装没有更新恢复记录');
    await store.load();
    const record = store.latest();
    if (!record) throw new Error('当前没有可恢复的更新');
    await assertManagedAncestors(this.fileSystem, record.targetPath, path.dirname(record.targetPath));
    this.transaction = record;
    if (action === 'keep-current') {
      if (record.toVersion === this.state.currentVersion && record.phase === 'awaiting-health') return this.confirmHealthy();
      record.phase = 'abandoned'; record.error = '';
      await store.save(record);
      this.transaction = null;
      return this.setState({ status: 'idle', recovery: null, installAction: null, message: '已保留当前版本，可重新检查更新' });
    }
    if (action === 'retry') {
      if (record.phase !== 'prepared') {
        const replacement = { ...record, id: crypto.randomUUID(), phase: 'prepared', error: '', createdAt: new Date().toISOString() };
        Object.assign(replacement, transactionPaths(record.targetPath, replacement.id, this.platform));
        const source = record.downloadPath || record.sourcePath;
        const directory = this.platform === 'darwin'
          ? path.join(path.dirname(store.filePath), 'packages', replacement.id) : replacement.stagingRoot;
        await assertManagedAncestors(this.fileSystem, source, this.platform === 'darwin' && !record.rollbackOf
          ? path.dirname(store.filePath) : path.dirname(record.targetPath));
        await assertManagedAncestors(this.fileSystem, directory, this.platform === 'darwin'
          ? path.dirname(store.filePath) : path.dirname(record.targetPath));
        await this.fileSystem.mkdir(directory, { recursive: true });
        replacement.sourcePath = path.join(directory, path.basename(source));
        replacement.downloadPath = replacement.sourcePath;
        await this.fileSystem.copyFile(source, replacement.sourcePath, fsConstants.COPYFILE_EXCL);
        await store.save(replacement);
        this.transaction = replacement;
      }
      this.updateFilePath = this.transaction.downloadPath || this.transaction.sourcePath;
      this.setState({ status: 'downloaded', installAction: 'relaunch', recovery: null });
      return this.install();
    }
    if (action !== 'rollback') throw new Error('更新恢复操作无效');
    await assertManagedAncestors(this.fileSystem, record.backupPath, path.dirname(record.targetPath));
    const backup = await this.fileSystem.lstat(record.backupPath);
    if (backup.isSymbolicLink() || (this.platform === 'darwin' ? !backup.isDirectory() : !backup.isFile())) throw new Error('上一版本备份无效');
    if (this.platform !== 'darwin' && record.backupSha256 && await this.hashFile(record.backupPath) !== record.backupSha256) {
      throw new Error('上一版本备份内容已发生变化，无法自动恢复');
    }
    const restored = { ...record, id: crypto.randomUUID(), rollbackOf: record.id, fromVersion: this.state.currentVersion,
      toVersion: record.fromVersion, phase: 'prepared', createdAt: new Date().toISOString(), error: '' };
    Object.assign(restored, transactionPaths(record.targetPath, restored.id, this.platform));
    await assertManagedAncestors(this.fileSystem, restored.stagingRoot, path.dirname(record.targetPath));
    await this.fileSystem.mkdir(restored.stagingRoot, { recursive: true });
    restored.sourcePath = path.join(restored.stagingRoot, path.basename(record.targetPath));
    if (this.platform === 'darwin') await this.fileSystem.cp(record.backupPath, restored.sourcePath, { recursive: true, dereference: false });
    else await this.fileSystem.copyFile(record.backupPath, restored.sourcePath, fsConstants.COPYFILE_EXCL);
    restored.downloadPath = restored.sourcePath;
    restored.sha256 = this.platform === 'darwin' ? record.sha256 : await this.hashFile(restored.sourcePath);
    await store.save(restored);
    this.transaction = restored;
    return this.withOperation((signal) => this.performInstall(signal, { rollback: true }));
  }

  async listHistory() {
    if (this.operationPromise) throw new Error('更新正在进行，请稍后清理旧版本');
    const target = this.getInstallationTarget();
    this.historyCandidates.clear();
    if (this.platform !== 'win32' || !target) return [];
    const store = this.ensureStore();
    await store.load();
    const protectedPaths = new Set([target, ...store.records.flatMap((record) => [record.sourcePath, record.downloadPath, record.backupPath])]
      .filter(Boolean).map((entry) => identity(entry, this.platform)));
    const entries = await this.fileSystem.readdir(path.dirname(target), { withFileTypes: true });
    for (const entry of entries) {
      const legacyName = /^The-Melody-of-Oblivion-Remake-(?:v\d+\.\d+\.\d+-)?Windows-(?:x64|ia32|arm64)\.exe(?:\.old)?$/i.test(entry.name)
        || entry.name.toLowerCase() === `${path.basename(target)}.old`.toLowerCase();
      if (!entry.isFile() || !legacyName) continue;
      const filePath = path.join(path.dirname(target), entry.name);
      if (protectedPaths.has(identity(filePath, this.platform))) continue;
      const stat = await this.fileSystem.lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const candidate = { id: crypto.randomUUID(), name: entry.name, path: filePath, size: stat.size,
        modifiedAt: stat.mtimeMs, sha256: await this.hashFile(filePath) };
      this.historyCandidates.set(candidate.id, candidate);
    }
    return [...this.historyCandidates.values()].map(({ sha256: _sha256, modifiedAt: _modifiedAt, ...entry }) => entry);
  }

  async cleanupHistory(ids) {
    if (this.operationPromise) throw new Error('更新正在进行，请稍后清理旧版本');
    if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => typeof id !== 'string')) throw new Error('请选择要清理的旧版本文件');
    const result = { removed: [], skipped: [] };
    for (const id of new Set(ids)) {
      const entry = this.historyCandidates.get(id);
      if (!entry) { result.skipped.push(id); continue; }
      try {
        const stat = await this.fileSystem.lstat(entry.path);
        if (identity(entry.path, this.platform) === identity(this.getInstallationTarget(), this.platform)
          || !stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size || stat.mtimeMs !== entry.modifiedAt
          || await this.hashFile(entry.path) !== entry.sha256) throw new Error('旧文件已发生变化');
        if (typeof this.shell?.trashItem !== 'function') throw new Error('当前环境无法将旧版本移入回收站');
        await this.shell.trashItem(entry.path);
        result.removed.push(id);
      } catch { result.skipped.push(id); }
      this.historyCandidates.delete(id);
    }
    return result;
  }
}

module.exports = {
  GITHUB_MIRRORS,
  UPDATE_CHANNEL,
  UpdateManager,
  downloadToFile,
  isNewerVersion,
  normalizeVersion,
  percent,
  pickAsset
};
