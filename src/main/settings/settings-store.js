const path = require('node:path');
const { RecoverableJsonStore, isJsonObject } = require('../recoverable-json-store');

const DOWNLOAD_CONCURRENCY_OPTIONS = Object.freeze([4, 8, 12, 16, 24, 32]);
const DOWNLOAD_SOURCE_OPTIONS = Object.freeze(['auto', 'bmclapi', 'official']);
const LAUNCHER_UPDATE_POLICY_OPTIONS = Object.freeze(['auto', 'notify', 'off']);
const DEFAULT_SETTINGS = Object.freeze({
  version: 3,
  javaPath: '',
  javaRuntimes: Object.freeze([]),
  wallpaperIndex: 3,
  isolateProfiles: true,
  gameDirectoryMode: 'local',
  downloadSource: 'auto',
  downloadConcurrency: 32,
  memoryMb: 4096,
  autoUpdate: true,
  launcherUpdatePolicy: 'auto'
});

// 旧版布尔设置 launcherAutoUpdate 迁移为三档策略
function normalizeLauncherUpdatePolicy(value, legacyBoolean) {
  if (LAUNCHER_UPDATE_POLICY_OPTIONS.includes(value)) return value;
  if (typeof legacyBoolean === 'boolean') return legacyBoolean ? 'auto' : 'off';
  return DEFAULT_SETTINGS.launcherUpdatePolicy;
}

function normalizeSettings(value = {}) {
  if (!isJsonObject(value)) throw new Error('设置文件结构无效');
  const requestedConcurrency = Number(value.downloadConcurrency);
  const requestedMemory = Number(value.memoryMb);
  const requestedJavaPath = typeof value.javaPath === 'string'
    ? value.javaPath.trim()
    : '';
  return {
    version: 3,
    wallpaperIndex: Number.isInteger(value.wallpaperIndex) && value.wallpaperIndex >= 0 && value.wallpaperIndex < 4
      ? value.wallpaperIndex : DEFAULT_SETTINGS.wallpaperIndex,
    javaPath: requestedJavaPath && path.isAbsolute(requestedJavaPath)
      ? path.normalize(requestedJavaPath)
      : DEFAULT_SETTINGS.javaPath,
    javaRuntimes: normalizeJavaRuntimes(value.javaRuntimes, requestedJavaPath),
    isolateProfiles: value.isolateProfiles !== false,
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
    launcherUpdatePolicy: normalizeLauncherUpdatePolicy(value.launcherUpdatePolicy, value.launcherAutoUpdate)
  };
}

function validateStoredSettings(value) {
  const stringFields = ['javaPath', 'downloadSource', 'launcherUpdatePolicy', 'gameDirectoryMode'];
  const booleanFields = ['isolateProfiles', 'autoUpdate', 'launcherAutoUpdate'];
  if (!isJsonObject(value)
      || (value.version !== undefined && (!Number.isInteger(value.version) || value.version < 1 || value.version > 3))
      || stringFields.some((field) => value[field] !== undefined && typeof value[field] !== 'string')
      || booleanFields.some((field) => value[field] !== undefined && typeof value[field] !== 'boolean')
      || (value.javaRuntimes !== undefined && (!Array.isArray(value.javaRuntimes)
        || value.javaRuntimes.some((entry) => !isJsonObject(entry) || typeof entry.path !== 'string')))) {
    throw new Error('设置文件结构无效');
  }
}

function normalizeJavaRuntimes(value, selectedPath = '') {
  const entries = Array.isArray(value) ? value.slice(0, 64) : [];
  const runtimes = new Map();
  for (const entry of [{ path: selectedPath }, ...entries]) {
    const candidate = typeof entry?.path === 'string' ? entry.path.trim() : '';
    if (!candidate || !path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    const majorVersion = Number.isInteger(entry.majorVersion) && entry.majorVersion > 0
      ? entry.majorVersion : runtimes.get(key)?.majorVersion;
    runtimes.set(key, { path: normalized, ...(majorVersion ? { majorVersion } : {}) });
  }
  return [...runtimes.values()].slice(0, 64);
}

class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
    this.storage = new RecoverableJsonStore(filePath, { validate: validateStoredSettings, label: '设置文件' });
  }

  async read() {
    return normalizeSettings(await this.storage.read());
  }

  async write(settings) {
    const normalized = normalizeSettings(settings);
    await this.storage.write(normalized);
    return normalized;
  }

  runExclusive(operation) {
    const next = this.storage.runExclusive(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  async getState() {
    const state = await this.read();
    return this.recovery ? { ...state, recovery: { ...this.recovery } } : state;
  }

  get recovery() { return this.storage.recovery; }

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
  LAUNCHER_UPDATE_POLICY_OPTIONS,
  SettingsStore,
  normalizeSettings
};
