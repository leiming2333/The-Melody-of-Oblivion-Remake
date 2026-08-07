const fs = require('node:fs/promises');
const path = require('node:path');

const DOWNLOAD_CONCURRENCY_OPTIONS = Object.freeze([4, 8, 12, 16, 24, 32]);
const DOWNLOAD_SOURCE_OPTIONS = Object.freeze(['auto', 'bmclapi', 'official']);
const DEFAULT_SETTINGS = Object.freeze({
  version: 3,
  javaPath: '',
  gameDirectoryMode: 'local',
  downloadSource: 'auto',
  downloadConcurrency: 32,
  memoryMb: 4096,
  autoUpdate: true,
  launcherAutoUpdate: true
});

function normalizeSettings(value = {}) {
  const requestedConcurrency = Number(value.downloadConcurrency);
  const requestedMemory = Number(value.memoryMb);
  const requestedJavaPath = typeof value.javaPath === 'string'
    ? value.javaPath.trim()
    : '';
  return {
    version: 3,
    javaPath: requestedJavaPath && path.isAbsolute(requestedJavaPath)
      ? path.normalize(requestedJavaPath)
      : DEFAULT_SETTINGS.javaPath,
    gameDirectoryMode: value.gameDirectoryMode === 'system' ? 'system' : 'local',
    downloadSource: DOWNLOAD_SOURCE_OPTIONS.includes(value.downloadSource)
      ? value.downloadSource
      : DEFAULT_SETTINGS.downloadSource,
    downloadConcurrency: DOWNLOAD_CONCURRENCY_OPTIONS.includes(requestedConcurrency)
      ? requestedConcurrency
      : DEFAULT_SETTINGS.downloadConcurrency,
    memoryMb: Number.isFinite(requestedMemory)
      ? Math.min(16384, Math.max(2048, Math.round(requestedMemory / 512) * 512))
      : DEFAULT_SETTINGS.memoryMb,
    autoUpdate: typeof value.autoUpdate === 'boolean'
      ? value.autoUpdate
      : DEFAULT_SETTINGS.autoUpdate,
    launcherAutoUpdate: typeof value.launcherAutoUpdate === 'boolean'
      ? value.launcherAutoUpdate
      : DEFAULT_SETTINGS.launcherAutoUpdate
  };
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      return normalizeSettings(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) {
        return normalizeSettings();
      }
      throw error;
    }
  }

  async write(settings) {
    const normalized = normalizeSettings(settings);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.part`;
    await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    await fs.rm(this.filePath, { force: true });
    await fs.rename(temporary, this.filePath);
    return normalized;
  }

  runExclusive(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }

  getState() {
    return this.read();
  }

  update(patch = {}) {
    return this.runExclusive(async () => {
      const current = await this.read();
      return this.write({ ...current, ...patch });
    });
  }
}

module.exports = {
  DEFAULT_SETTINGS,
  DOWNLOAD_CONCURRENCY_OPTIONS,
  DOWNLOAD_SOURCE_OPTIONS,
  SettingsStore,
  normalizeSettings
};
