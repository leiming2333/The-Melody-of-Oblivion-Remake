const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { runFileExclusive } = require('../file-write-queue');
const { ModManager } = require('./mod-manager');
const { fetchWithTimeout } = require('./source-manager');
const { DEFAULT_SEGMENT_CONCURRENCY, downloadFile, safePath, throwIfAborted } = require('./downloader');

const FABRIC_API_PROJECT_ID = 'P7dR8mSH';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_CDN = 'https://cdn.modrinth.com';
const VERSION_ID = /^[a-zA-Z0-9]{1,64}$/;
const API_FILENAME = /^fabric[-_]api(?:[-+.]|\.jar(?:\.disabled)?$)/i;

function apiError(code, message, details, retryable = false, phase = 'fabric-api-metadata') {
  return Object.assign(new Error(message), { code, details, retryable, phase });
}

function validateGameVersion(gameVersion) {
  if (typeof gameVersion !== 'string' || !/^[0-9A-Za-z._+-]{1,80}$/.test(gameVersion)) {
    throw apiError('FABRIC_API_METADATA_INVALID', 'Minecraft 版本号无效');
  }
}

function validateVersionId(versionId) {
  if (typeof versionId !== 'string' || !VERSION_ID.test(versionId)) {
    throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 版本 ID 无效');
  }
}

function validateCdnUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Report one actionable metadata error. */ }
  if (!url || url.origin !== MODRINTH_CDN || url.username || url.password || url.hash || url.search) {
    throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 下载地址不是官方 HTTPS CDN');
  }
  return url;
}

function validatedVersion(value, gameVersion, requestedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 版本信息格式无效');
  }
  validateVersionId(value.id);
  if (requestedId && value.id !== requestedId) {
    throw apiError('FABRIC_API_VERSION_MISMATCH', 'Modrinth 返回了不同的 Fabric API 版本，已停止安装');
  }
  if (!Array.isArray(value.game_versions) || !value.game_versions.every((entry) => typeof entry === 'string')
      || !Array.isArray(value.loaders) || !value.loaders.every((entry) => typeof entry === 'string')) {
    throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 兼容版本信息格式无效');
  }
  if (value.project_id !== FABRIC_API_PROJECT_ID || !value.game_versions.includes(gameVersion) || !value.loaders.includes('fabric')) {
    throw apiError('FABRIC_API_INCOMPATIBLE', `所选 Fabric API 不兼容 Minecraft ${gameVersion} / Fabric，或不属于 Fabric API 项目`);
  }
  if (typeof value.version_number !== 'string' || !value.version_number || value.version_number.length > 120
      || typeof value.name !== 'string' || !value.name || value.name.length > 240
      || !['release', 'beta', 'alpha'].includes(value.version_type)
      || typeof value.date_published !== 'string' || !Number.isFinite(Date.parse(value.date_published))
      || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 64) {
    throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 版本信息缺少有效的名称、日期或文件');
  }
  const primary = value.files.filter((file) => file?.primary === true);
  if (primary.length !== 1) throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 没有唯一的主下载文件');
  const file = primary[0];
  if (typeof file.filename !== 'string' || file.filename.length > 180
      || /[\\/:*?"<>|\0-\x1f]/.test(file.filename) || !/^fabric-api(?:[-+].+)?\.jar$/i.test(file.filename)
      || !Number.isSafeInteger(file.size) || file.size <= 0
      || !/^[a-f0-9]{40}$/i.test(file.hashes?.sha1 ?? '') || !/^[a-f0-9]{128}$/i.test(file.hashes?.sha512 ?? '')) {
    throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 文件名、文件大小或校验信息无效');
  }
  const url = validateCdnUrl(file.url);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { /* Invalid escapes are rejected below. */ }
  if (pathname !== `/data/${FABRIC_API_PROJECT_ID}/versions/${value.id}/${file.filename}`) {
    throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 下载地址与所选项目或版本不符');
  }
  return {
    id: value.id, gameVersion, version: value.version_number, name: value.name,
    versionType: value.version_type, datePublished: value.date_published,
    file: { filename: file.filename, url: url.href, size: file.size,
      sha1: file.hashes.sha1.toLowerCase(), sha512: file.hashes.sha512.toLowerCase() }
  };
}

async function fetchModrinthJson(url, { signal } = {}) {
  return fetchWithTimeout(url, { signal, headers: { Accept: 'application/json' } }, 15000, async (response) => {
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw apiError('NETWORK_ERROR', `Fabric API 信息获取失败（HTTP ${response.status}），请检查网络后重试`,
        { url, status: response.status }, true);
    }
    return response.json();
  });
}

// Check each component inside the selected game root: an intermediate junction
// must not redirect a supposedly isolated instance or cache outside that root.
async function ensureDirectoryInside(root, target, signal) {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw apiError('FABRIC_API_UNSAFE_PATH', 'Fabric API 安装目录必须位于当前游戏目录内', undefined, false, 'fabric-api-install');
  }
  const directories = [root];
  for (const segment of relative.split(path.sep).filter(Boolean)) directories.push(path.join(directories.at(-1), segment));
  for (const directory of directories) {
    throwIfAborted(signal);
    try {
      const info = await fs.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw apiError('FABRIC_API_UNSAFE_PATH', 'Fabric API 安装目录不能包含链接、目录联接或普通文件', undefined, false, 'fabric-api-install');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(directory, { recursive: directory === root });
    }
  }
}

async function matchesFile(filePath, expected, signal) {
  const info = await fs.lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size) return false;
  const sha1 = crypto.createHash('sha1');
  const sha512 = crypto.createHash('sha512');
  const handle = await fs.open(filePath, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      throwIfAborted(signal);
      sha1.update(chunk); sha512.update(chunk);
    }
  } finally { await handle.close(); }
  throwIfAborted(signal);
  return sha1.digest('hex') === expected.sha1 && sha512.digest('hex') === expected.sha512;
}

function conflict(names, disabled = false) {
  return apiError('FABRIC_API_CONFLICT', disabled
    ? '已有相同的 Fabric API 处于禁用状态，请先在 Mod 管理中启用或移除该文件'
    : '实例中已有其他或同名的 Fabric API，请先在 Mod 管理中检查并移除冲突文件；现有 Mod 未被覆盖',
  { files: names }, false, 'fabric-api-install');
}

class FabricApiManager {
  constructor({ gameDirectory, fetchJson = fetchModrinthJson, download = downloadFile,
    modManager = new ModManager(), segmentConcurrency = DEFAULT_SEGMENT_CONCURRENCY,
    retryDelayMs = 250, cacheDurationMs = 5 * 60 * 1000 } = {}) {
    this.gameDirectory = gameDirectory;
    this.fetchJson = fetchJson;
    this.download = download;
    this.modManager = modManager;
    this.segmentConcurrency = segmentConcurrency;
    this.retryDelayMs = retryDelayMs;
    this.cacheDurationMs = cacheDurationMs;
    this.cache = new Map();
  }

  async requestJson(url, signal) {
    throwIfAborted(signal);
    try {
      const value = await this.fetchJson(url, { signal });
      throwIfAborted(signal);
      return value;
    } catch (error) {
      throwIfAborted(signal);
      if (error.code === 'NETWORK_ERROR') throw error;
      if (error instanceof SyntaxError) throw apiError('FABRIC_API_METADATA_INVALID', 'Modrinth 返回的 Fabric API JSON 已损坏');
      throw apiError('NETWORK_ERROR', `Fabric API 信息获取失败：${error.message}`, { url }, true);
    }
  }

  async listVersions(gameVersion, { force = false, signal } = {}) {
    validateGameVersion(gameVersion);
    throwIfAborted(signal);
    const cached = this.cache.get(gameVersion);
    if (!force && cached && Date.now() - cached.fetchedAt < this.cacheDurationMs) return structuredClone(cached.result);
    const query = new URLSearchParams({ game_versions: JSON.stringify([gameVersion]), loaders: JSON.stringify(['fabric']) });
    const data = await this.requestJson(`${MODRINTH_API}/project/${FABRIC_API_PROJECT_ID}/version?${query}`, signal);
    if (!Array.isArray(data) || data.length > 10000) throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 版本列表格式无效');
    const versions = [];
    for (const entry of data) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 版本列表包含无效数据');
      if (!Array.isArray(entry.game_versions) || !Array.isArray(entry.loaders)) {
        throw apiError('FABRIC_API_METADATA_INVALID', 'Fabric API 兼容版本列表格式无效');
      }
      if (entry.project_id !== FABRIC_API_PROJECT_ID || !entry.game_versions.includes(gameVersion) || !entry.loaders.includes('fabric')) continue;
      const { id, version, name, versionType, datePublished } = validatedVersion(entry, gameVersion);
      versions.push({ id, version, name, versionType, datePublished });
    }
    versions.sort((a, b) => Date.parse(b.datePublished) - Date.parse(a.datePublished));
    const result = { gameVersion, versions };
    throwIfAborted(signal);
    this.cache.set(gameVersion, { fetchedAt: Date.now(), result });
    return structuredClone(result);
  }

  async resolveVersion(gameVersion, versionId, { signal } = {}) {
    validateGameVersion(gameVersion);
    validateVersionId(versionId);
    // Deliberately re-fetch on every install; UI list caching never grants
    // authority to a URL, digest or compatibility assertion from the renderer.
    return validatedVersion(await this.requestJson(`${MODRINTH_API}/version/${versionId}`, signal), gameVersion, versionId);
  }

  async existingVersion(instanceDirectory, version, signal) {
    const directory = await this.modManager.directory(instanceDirectory);
    const names = await fs.readdir(directory);
    const knownApi = names.filter((name) => API_FILENAME.test(name) && /\.jar(?:\.disabled)?$/i.test(name));
    let matching;
    // Check equal-sized files too, so a byte-identical manually renamed JAR is
    // idempotent without hashing every large mod in an existing installation.
    for (const name of names.filter((entry) => /\.jar(?:\.disabled)?$/i.test(entry))) {
      throwIfAborted(signal);
      if (await matchesFile(path.join(directory, name), version.file, signal)) {
        if (/\.disabled$/i.test(name)) throw conflict([name], true);
        matching ??= name;
      }
    }
    const otherApi = knownApi.filter((name) => name !== matching);
    if (otherApi.length) throw conflict(otherApi);
    if (matching) return matching;
    if (names.includes(version.file.filename)) throw conflict([version.file.filename]);
    return undefined;
  }

  async installVersion({ gameVersion, versionId, instanceDirectory }, onProgress = () => {}, { signal } = {}) {
    if (typeof this.gameDirectory !== 'string' || !path.isAbsolute(this.gameDirectory)
        || typeof instanceDirectory !== 'string' || !path.isAbsolute(instanceDirectory)) {
      throw apiError('FABRIC_API_UNSAFE_PATH', '请先选择有效的游戏目录和实例目录', undefined, false, 'fabric-api-install');
    }
    const root = path.resolve(this.gameDirectory);
    let instance;
    try { instance = safePath(root, instanceDirectory); }
    catch { throw apiError('FABRIC_API_UNSAFE_PATH', 'Fabric API 安装目录必须位于当前游戏目录内', undefined, false, 'fabric-api-install'); }
    return runFileExclusive(path.join(instance, 'mods', '.fabric-api-install'), async () => {
      throwIfAborted(signal);
      const version = await this.resolveVersion(gameVersion, versionId, { signal });
      await ensureDirectoryInside(root, instance, signal);
      await ensureDirectoryInside(root, path.join(instance, 'mods'), signal);
      const result = (fileName, alreadyInstalled) => ({ gameVersion, versionId: version.id, version: version.version,
        name: version.name, fileName, instanceDirectory: instance, installed: true, alreadyInstalled });
      const existing = await this.existingVersion(instance, version, signal);
      if (existing) return result(existing, true);
      const cacheRoot = safePath(root, 'launcher-cache', 'fabric-api');
      await ensureDirectoryInside(root, cacheRoot, signal);
      const stage = await fs.mkdtemp(path.join(cacheRoot, 'download-'));
      const downloaded = safePath(stage, version.file.filename);
      let primaryError;
      let installedResult;
      const completedResult = (fileName, alreadyInstalled) => {
        installedResult = result(fileName, alreadyInstalled);
        return installedResult;
      };
      try {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          throwIfAborted(signal);
          try {
            onProgress({ phase: 'downloading', message: `正在下载 Fabric API ${version.version}…`, receivedBytes: 0, completedBytes: 0,
              totalBytes: version.file.size, completedFiles: 0, totalFiles: 1, attempt, cancellable: true });
            await this.download({ label: `Fabric API ${version.version}`, urls: [version.file.url], destination: downloaded,
              sha1: version.file.sha1, size: version.file.size, signal, segmentConcurrency: this.segmentConcurrency,
              validateRedirect: validateCdnUrl,
              onBytes: (receivedBytes) => onProgress({ phase: 'downloading', message: `正在下载 Fabric API ${version.version}…`,
                receivedBytes, completedBytes: receivedBytes, totalBytes: version.file.size, completedFiles: 0, totalFiles: 1, attempt, cancellable: true }) });
            if (!(await matchesFile(downloaded, version.file, signal))) {
              throw apiError('CHECKSUM_MISMATCH', 'Fabric API 文件校验失败，请重试', undefined, true, 'verifying-fabric-api');
            }
            break;
          } catch (error) {
            await fs.rm(downloaded, { force: true });
            throwIfAborted(signal);
            if (error.name === 'AbortError' || attempt === 3 || /ENOSPC|EACCES|EPERM|EROFS/.test(`${error.code ?? ''} ${error.message}`)) throw error;
            onProgress({ phase: 'downloading', message: `Fabric API 下载失败，正在重试（${attempt + 1}/3）…`, attempt: attempt + 1, cancellable: true });
            if (this.retryDelayMs > 0) await delay(this.retryDelayMs * attempt, undefined, { signal });
          }
        }
        await ensureDirectoryInside(root, path.join(instance, 'mods'), signal);
        const rechecked = await this.existingVersion(instance, version, signal);
        if (rechecked) return completedResult(rechecked, true);
        throwIfAborted(signal);
        onProgress({ phase: 'committing-fabric-api', message: '正在将 Fabric API 保存到实例 Mod 目录…', cancellable: false });
        // ModManager uses COPYFILE_EXCL and serializes mutations. Existing user
        // files are preserved even if another import wins the filename race.
        try {
          await this.modManager.importFile(instance, downloaded);
        } catch (error) {
          if (error.code !== 'EEXIST' && !/同名 Mod/.test(error.message)) throw error;
          const concurrent = await this.existingVersion(instance, version);
          if (concurrent) return completedResult(concurrent, true);
          throw conflict([version.file.filename]);
        }
        const target = safePath(instance, 'mods', version.file.filename);
        if (!(await matchesFile(target, version.file))) {
          await fs.rm(target, { force: true });
          throw apiError('CHECKSUM_MISMATCH', 'Fabric API 保存后校验失败，已清理不完整文件，请重试', undefined, true, 'committing-fabric-api');
        }
        onProgress({ phase: 'complete', message: `Fabric API ${version.version} 安装完成`, completedFiles: 1,
          totalFiles: 1, receivedBytes: version.file.size, completedBytes: version.file.size, totalBytes: version.file.size, cancellable: false });
        return completedResult(version.file.filename, false);
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        try { await fs.rm(stage, { recursive: true, force: true }); }
        catch (cleanupError) {
          const cleanupMessage = `Fabric API 临时文件清理失败：${cleanupError.message}；目录：${stage}`;
          if (primaryError) primaryError.details = { ...primaryError.details, cleanupMessage };
          else if (installedResult) installedResult.cleanupWarning = cleanupMessage;
        }
      }
    });
  }
}

module.exports = { FabricApiManager, FABRIC_API_PROJECT_ID };
