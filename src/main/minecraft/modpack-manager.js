const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns/promises');
const net = require('node:net');
const crypto = require('node:crypto');
const streamFs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { runFileExclusive } = require('../file-write-queue');
const {
  createDownloadProgressTracker,
  runPool,
  safePath,
  throwIfAborted,
  writeJsonAtomic
} = require('./downloader');
const { fetchWithTimeout } = require('./source-manager');
const { readModpackManifest, extractModpackArchive } = require('./modpack-archive');
const { downloadModpackFile, hasCachedModpackFile, importModpackFile } = require('./modpack-download-cache');
const { STAGING_MARKER, createStagingDirectory, removeStagingDirectory,
  releaseStagingDirectory, cleanupStaleStaging } = require('./modpack-staging');

const MODPACK_EXTENSIONS = Object.freeze(['.mrpack', '.zip']);
const INSTANCE_ID_PATTERN = /^[0-9A-Za-z._-]{1,100}$/;
const RECOVERY_SCHEMA_VERSION = 1;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_REASONS = new Set(['metadata-unavailable', 'restricted', 'download-failed']);
const PRIVATE_NETWORKS = new net.BlockList();
for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'], ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'], ['ff00::', 8, 'ipv6']
]) PRIVATE_NETWORKS.addSubnet(address, prefix, family);

function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (!family || (family === 6 && address.toLowerCase().startsWith('::ffff:'))) return true;
  return PRIVATE_NETWORKS.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

function requireVersion(value, label = 'Minecraft') {
  const version = String(value ?? '');
  if (!/^[0-9A-Za-z._+-]{1,100}$/.test(version)) {
    throw new Error(`整合包缺少有效的 ${label} 版本`);
  }
  return version;
}

function safeRelativePath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (
    !normalized || segments.length === 0
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => segment === '..' || segment.includes('\0') || /[<>:"|?*]/.test(segment)
      || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))
  ) {
    throw new Error(`整合包包含不安全的文件路径：${value}`);
  }
  return segments.join('/');
}

function safeDownloadUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('整合包包含无效的模组下载地址');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || (net.isIP(hostname) && isBlockedAddress(hostname))
  ) {
    throw new Error(`整合包包含不安全的模组下载地址：${parsed.hostname}`);
  }
  return parsed.toString();
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function serializeCurseForgeEntry(value, { missing = false } = {}) {
  const projectId = Number(value?.projectId);
  const fileId = Number(value?.fileId);
  if (!Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(fileId) || fileId < 1) return undefined;
  const result = { projectId, fileId, required: value.required !== false };
  if (typeof value.fileName === 'string' && value.fileName
    && safeRelativePath(value.fileName) === value.fileName && !value.fileName.includes('/')) {
    result.fileName = value.fileName;
    result.path = `mods/${value.fileName}`;
  }
  if (Array.isArray(value.urls)) result.urls = value.urls.slice(0, 8).map(safeDownloadUrl);
  else result.urls = [];
  if (/^[0-9a-f]{40}$/i.test(value.sha1 ?? '')) result.sha1 = value.sha1.toLowerCase();
  if (Number.isSafeInteger(value.size) && value.size >= 0) result.size = value.size;
  if (missing && RECOVERY_REASONS.has(value.reason)) result.reason = value.reason;
  if (!missing && (!result.fileName || !result.path)) return undefined;
  return result;
}

function serializeRecoverySession(session) {
  if (!SESSION_ID_PATTERN.test(session?.sessionId ?? '')
    || typeof session.archivePath !== 'string' || !path.isAbsolute(session.archivePath)
    || !/^[0-9a-f]{64}$/i.test(session.fingerprint ?? '')) return undefined;
  const metadata = [...session.metadata.values()].map((entry) => serializeCurseForgeEntry(entry)).filter(Boolean);
  const missing = [...session.missing.values()].map((entry) => serializeCurseForgeEntry(entry, { missing: true })).filter(Boolean);
  return {
    sessionId: session.sessionId,
    archivePath: session.archivePath,
    gameDirectory: session.gameDirectory,
    fingerprint: session.fingerprint.toLowerCase(),
    installOptionalFiles: session.installOptionalFiles === true,
    name: String(session.name ?? path.basename(session.archivePath)).slice(0, 100),
    metadata,
    missing,
    updatedAt: session.updatedAt ?? new Date().toISOString()
  };
}

function restoreRecoverySession(value, gameDirectory) {
  if (!value || !samePath(value.gameDirectory, gameDirectory)) return undefined;
  const base = serializeRecoverySession({
    ...value,
    metadata: new Map((Array.isArray(value.metadata) ? value.metadata : []).map((entry) => [
      `${entry?.projectId}:${entry?.fileId}`, entry
    ])),
    missing: new Map((Array.isArray(value.missing) ? value.missing : []).map((entry) => [
      `${entry?.projectId}:${entry?.fileId}`, entry
    ]))
  });
  if (!base) return undefined;
  const archivePath = validateModpackFile(base.archivePath);
  const metadata = new Map(base.metadata.map((entry) => [`${entry.projectId}:${entry.fileId}`, entry]));
  const missing = new Map(base.missing.map((entry) => [`${entry.projectId}:${entry.fileId}`, entry]));
  return { ...base, archivePath, gameDirectory: path.resolve(gameDirectory), metadata, missing, ownerId: null,
    busy: false, cancellable: true, controller: null, waiting: true };
}

async function validatePublicDownloadUrl(value, lookupHost = defaultLookupHost) {
  const validated = safeDownloadUrl(value);
  const hostname = new URL(validated).hostname;
  if (net.isIP(hostname)) return validated;
  const addresses = await lookupHost(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0
    || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error(`整合包下载地址解析到不安全的网络：${hostname}`);
  }
  return validated;
}

function defaultLookupHost(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function loaderFromModrinthDependencies(dependencies = {}) {
  if (dependencies['fabric-loader']) {
    return { loaderType: 'fabric', loaderVersion: requireVersion(dependencies['fabric-loader'], 'Fabric') };
  }
  if (dependencies.forge) {
    return { loaderType: 'forge', loaderVersion: requireVersion(dependencies.forge, 'Forge') };
  }
  if (dependencies.neoforge) {
    return { loaderType: 'neoforge', loaderVersion: requireVersion(dependencies.neoforge, 'NeoForge') };
  }
  if (dependencies['quilt-loader']) {
    return { loaderType: 'quilt', loaderVersion: requireVersion(dependencies['quilt-loader'], 'Quilt') };
  }
  return { loaderType: 'vanilla', loaderVersion: requireVersion(dependencies.minecraft) };
}

function parseModrinthIndex(index) {
  if (!index || index.formatVersion !== 1 || index.game !== 'minecraft') {
    throw new Error('Modrinth 整合包索引格式无效');
  }
  const gameVersion = requireVersion(index.dependencies?.minecraft);
  const loader = loaderFromModrinthDependencies(index.dependencies);
  const files = Array.isArray(index.files) ? index.files
    .filter((file) => file?.env?.client !== 'unsupported')
    .map((file) => {
      if (!file || typeof file.path !== 'string' || !Array.isArray(file.downloads)) {
        throw new Error('Modrinth 整合包包含无效的文件记录');
      }
      if (file.hashes?.sha1 !== undefined && !/^[0-9a-f]{40}$/i.test(file.hashes.sha1)) {
        throw new Error('Modrinth 整合包包含无效的文件校验信息');
      }
      return {
        path: safeRelativePath(file.path),
        urls: file.downloads.map(safeDownloadUrl),
        sha1: file.hashes?.sha1?.toLowerCase(),
        size: Number.isSafeInteger(file.fileSize) && file.fileSize >= 0 ? file.fileSize : undefined,
        required: file.env?.client !== 'optional'
      };
    }) : [];
  if (files.some((file) => file.urls.length === 0)) {
    throw new Error('Modrinth 整合包中存在没有下载地址的文件');
  }
  return {
    format: 'modrinth',
    name: String(index.name ?? index.versionId ?? 'Modrinth 整合包').slice(0, 100),
    version: String(index.versionId ?? '').slice(0, 100),
    gameVersion,
    ...loader,
    files,
    overrideDirectories: ['overrides', 'client-overrides']
  };
}

function parseCurseForgeManifest(manifest) {
  if (!manifest || manifest.manifestType !== 'minecraftModpack' || !manifest.minecraft) {
    throw new Error('CurseForge 整合包清单格式无效');
  }
  const gameVersion = requireVersion(manifest.minecraft.version);
  const loaders = Array.isArray(manifest.minecraft.modLoaders) ? manifest.minecraft.modLoaders : [];
  const selected = loaders.find((loader) => loader.primary) ?? loaders[0];
  let loaderType = 'vanilla';
  let loaderVersion = gameVersion;
  if (selected?.id) {
    const match = String(selected.id).match(/^(fabric|forge|neoforge|quilt)-(.+)$/i);
    if (!match) throw new Error(`暂不支持整合包加载器：${selected.id}`);
    loaderType = match[1].toLowerCase();
    loaderVersion = requireVersion(match[2], loaderType);
  }
  const files = Array.isArray(manifest.files) ? manifest.files.map((file) => {
    const projectId = Number(file?.projectID);
    const fileId = Number(file?.fileID);
    if (!Number.isSafeInteger(projectId) || projectId < 1 || !Number.isSafeInteger(fileId) || fileId < 1) {
      throw new Error('CurseForge 整合包包含无效的模组编号');
    }
    return { projectId, fileId, required: file.required !== false };
  }) : [];
  return {
    format: 'curseforge',
    name: String(manifest.name ?? 'CurseForge 整合包').slice(0, 100),
    version: String(manifest.version ?? '').slice(0, 100),
    author: String(manifest.author ?? '').slice(0, 100),
    gameVersion,
    loaderType,
    loaderVersion,
    files,
    overrideDirectories: [safeRelativePath(manifest.overrides || 'overrides')]
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`整合包清单已损坏：${path.basename(filePath)}`);
    throw error;
  }
}

async function findPackRoot(extractedRoot) {
  if (
    await readJson(path.join(extractedRoot, 'modrinth.index.json'))
    || await readJson(path.join(extractedRoot, 'manifest.json'))
  ) return extractedRoot;
  const entries = await fs.readdir(extractedRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory() && entry.name !== '__MACOSX');
  if (directories.length !== 1) return extractedRoot;
  return path.join(extractedRoot, directories[0].name);
}

async function parseExtractedPack(extractedRoot) {
  const packRoot = await findPackRoot(extractedRoot);
  const modrinth = await readJson(path.join(packRoot, 'modrinth.index.json'));
  if (modrinth) return { packRoot, pack: parseModrinthIndex(modrinth) };
  const curseForge = await readJson(path.join(packRoot, 'manifest.json'));
  if (curseForge) return { packRoot, pack: parseCurseForgeManifest(curseForge) };
  throw new Error('未找到 modrinth.index.json 或 CurseForge manifest.json');
}

function publicPackInfo(pack) {
  const requiredFileCount = pack.files.filter((file) => file.required !== false).length;
  return {
    format: pack.format,
    name: pack.name,
    version: pack.version,
    gameVersion: pack.gameVersion,
    loaderType: pack.loaderType,
    loaderVersion: pack.loaderVersion,
    fileCount: pack.files.length,
    requiredFileCount,
    optionalFileCount: pack.files.length - requiredFileCount
  };
}

function validateModpackFile(filePath) {
  const resolved = path.resolve(String(filePath ?? ''));
  if (!MODPACK_EXTENSIONS.includes(path.extname(resolved).toLowerCase())) {
    throw new Error('请拖入 Modrinth .mrpack 或 CurseForge .zip 整合包');
  }
  return resolved;
}

function createInstanceId(name, now = Date.now()) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[^0-9A-Za-z._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'modpack';
  return `${slug}-${now.toString(36)}`;
}

async function copyDirectoryContents(source, destination, { signal } = {}) {
  throwIfAborted(signal);
  let entries;
  try {
    entries = await fs.readdir(source, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    if (entry.name === STAGING_MARKER || entry.name === '.melody-instance.json') {
      throw modpackError('整合包覆盖文件包含启动器保留的配置名称', 'MODPACK_INVALID_METADATA', 'copying-overrides', false);
    }
    if (entry.isSymbolicLink()) throw new Error('整合包覆盖文件不能是链接');
    const target = safePath(destination, entry.name);
    const original = path.join(source, entry.name);
    if (entry.isDirectory()) await copyDirectoryContents(original, target, { signal });
    else if (entry.isFile()) {
      await pipeline(streamFs.createReadStream(original), streamFs.createWriteStream(target), { signal });
    } else throw new Error('整合包包含不支持的覆盖文件类型');
  }
}

function modpackError(message, code, phase, retryable = true, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, phase, retryable });
}

function isRemoteFailure(error) {
  if (error.name === 'AbortError' || error.retryable === false) return false;
  const diagnostic = `${error.code ?? ''} ${error.message}`;
  if (/EACCES|EPERM|ENOSPC|EDQUOT|EROFS|EISDIR|ENOTDIR|ENOENT|EBUSY|EMFILE|ENFILE|EIO|EEXIST|EINVAL|EFBIG|ENAMETOOLONG|ETXTBSY|ENOTEMPTY|不安全|无效的.*路径|目标路径|链接/i
    .test(diagnostic)) return false;
  return /下载失败|HTTP \d{3}|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR|连接|校验失败|network|timeout/i
    .test(diagnostic);
}

async function archiveFingerprint(filePath, signal) {
  throwIfAborted(signal);
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > 512 * 1024 * 1024) throw new Error('整合包归档无效或过大');
  const hash = crypto.createHash('sha256');
  const input = streamFs.createReadStream(filePath, { signal });
  for await (const chunk of input) { throwIfAborted(signal); hash.update(chunk); }
  throwIfAborted(signal);
  return hash.digest('hex');
}

async function queryCurseForgeMetadata(url, options, signal) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let status;
    try {
      const metadata = await fetchWithTimeout(url, options, 12000, async (response) => {
        status = response.status;
        return response.ok ? (await response.json()).data : undefined;
      });
      if (metadata || (status && status < 500 && status !== 429)) return metadata;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    if (attempt === 0) await delay(150, undefined, { signal });
  }
  return undefined;
}

async function resolveCurseForgeMetadata(entry, signal) {
  const communityUrl = `https://api.curse.tools/v1/cf/mods/${entry.projectId}/files/${entry.fileId}`;
  let metadata = await queryCurseForgeMetadata(communityUrl, { signal }, signal);

  if (!metadata && process.env.CURSEFORGE_API_KEY) {
    metadata = await queryCurseForgeMetadata(
      `https://api.curseforge.com/v1/mods/${entry.projectId}/files/${entry.fileId}`,
      { headers: { 'x-api-key': process.env.CURSEFORGE_API_KEY }, signal },
      signal
    );
  }
  if (!metadata?.fileName) {
    throw modpackError(`无法获取 CurseForge 文件信息（项目 ${entry.projectId}，文件 ${entry.fileId}），请重试查询`,
      'MODPACK_METADATA_UNAVAILABLE', 'resolving-files');
  }
  if ((metadata.id !== undefined && Number(metadata.id) !== entry.fileId)
    || (metadata.modId !== undefined && Number(metadata.modId) !== entry.projectId)
    || typeof metadata.fileName !== 'string' || safeRelativePath(metadata.fileName) !== metadata.fileName
    || metadata.fileName.includes('/')) {
    throw modpackError('CurseForge 返回了不匹配或不安全的文件信息', 'MODPACK_INVALID_METADATA', 'resolving-files', false);
  }
  const sha1 = metadata.hashes?.find((hash) => Number(hash.algo) === 1)?.value;
  return {
    ...entry,
    fileName: metadata.fileName,
    path: `mods/${metadata.fileName}`,
    urls: metadata.downloadUrl ? [safeDownloadUrl(metadata.downloadUrl)] : [],
    sha1: /^[0-9a-f]{40}$/i.test(sha1 ?? '') ? sha1.toLowerCase() : undefined,
    size: Number.isSafeInteger(metadata.fileLength) && metadata.fileLength >= 0 ? metadata.fileLength : undefined,
    officialUrl: `https://www.curseforge.com/projects/${entry.projectId}/files/${entry.fileId}`
  };
}

async function resolveCurseForgeFile(entry, signal) {
  const file = await resolveCurseForgeMetadata(entry, signal);
  if (!file.urls.length) throw modpackError(
    `CurseForge 文件禁止第三方自动下载（项目 ${entry.projectId}，文件 ${entry.fileId}），请从整合包发布页手动获取`,
    'MODPACK_FILE_RESTRICTED', 'resolving-files');
  return file;
}

class ModpackManager {
  constructor({ gameDirectory, loaderManager, concurrency = 16, segmentConcurrency = 8,
    lookupHost = defaultLookupHost, recoveryFile }) {
    this.gameDirectory = gameDirectory;
    this.loaderManager = loaderManager;
    this.concurrency = concurrency;
    this.segmentConcurrency = segmentConcurrency;
    this.lookupHost = lookupHost;
    this.sessions = new Map();
    this.recoveryFile = recoveryFile ?? safePath(gameDirectory, 'launcher-cache', 'modpack-recovery.json');
    this.recoveryLoaded = null;
  }

  loadRecoverySessions() {
    this.recoveryLoaded ??= fs.readFile(this.recoveryFile, 'utf8').then((text) => {
      const value = JSON.parse(text);
      if (value?.schemaVersion !== RECOVERY_SCHEMA_VERSION || !Array.isArray(value.sessions)) return;
      for (const record of value.sessions.slice(0, 8)) {
        try {
          const session = restoreRecoverySession(record, this.gameDirectory);
          if (session) this.sessions.set(session.sessionId, session);
        } catch {
          // Ignore individual records that were edited or belong to an older format.
        }
      }
    }).catch((error) => {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    });
    return this.recoveryLoaded;
  }

  saveRecoverySessions() {
    return runFileExclusive(this.recoveryFile, async () => {
      const sessions = [...this.sessions.values()]
        .filter((session) => session.waiting)
        .map(serializeRecoverySession)
        .filter(Boolean);
      if (sessions.length === 0) {
        await fs.rm(this.recoveryFile, { force: true });
        return;
      }
      await writeJsonAtomic(this.recoveryFile, { schemaVersion: RECOVERY_SCHEMA_VERSION, sessions });
    });
  }

  async claimRecoverySession(ownerId) {
    await this.loadRecoverySessions();
    const candidates = [...this.sessions.values()]
      .filter((session) => session.waiting && (session.ownerId === null || session.ownerId === (ownerId ?? null)))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    for (const session of candidates) {
      session.ownerId = ownerId ?? null;
      try {
        await this.verifySessionArchive(session);
        return this.getRecoveryState(session.sessionId, { ownerId });
      } catch (error) {
        if (error.code !== 'MODPACK_ARCHIVE_CHANGED') throw error;
      }
    }
    return null;
  }

  async withExtractedPack(filePath, operation, { signal, onProgress } = {}) {
    throwIfAborted(signal);
    const archivePath = validateModpackFile(filePath);
    const stat = await fs.stat(archivePath);
    if (!stat.isFile()) throw new Error('拖入的整合包文件无效');
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-'));
    try {
      onProgress?.({ phase: 'extracting', message: '正在检查并解压整合包…', cancellable: true });
      await extractModpackArchive(archivePath, temporaryRoot, { signal, onProgress });
      throwIfAborted(signal);
      const parsed = await parseExtractedPack(temporaryRoot);
      return await operation({ archivePath, ...parsed });
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  async inspect(filePath, { signal } = {}) {
    const manifest = await readModpackManifest(validateModpackFile(filePath), {}, { signal });
    const pack = manifest.name === 'modrinth.index.json'
      ? parseModrinthIndex(manifest.value)
      : parseCurseForgeManifest(manifest.value);
    if (pack.loaderType !== 'vanilla' && typeof this.loaderManager?.validateLoaderVersion === 'function') {
      try {
        await this.loaderManager.validateLoaderVersion(pack.gameVersion, pack.loaderType, pack.loaderVersion, signal);
      } catch (error) {
        throwIfAborted(signal);
        throw modpackError(`整合包加载器兼容性检查失败：${error.message}`,
          'MODPACK_LOADER_INCOMPATIBLE', 'inspecting', isRemoteFailure(error), error);
      }
    }
    return publicPackInfo(pack);
  }

  getSession(sessionId, ownerId) {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== (ownerId ?? null)
      || session.gameDirectory !== path.resolve(this.gameDirectory)) {
      throw modpackError('整合包恢复会话已失效，请重新选择归档', 'MODPACK_SESSION_EXPIRED', 'preparing', false);
    }
    return session;
  }

  getRecoveryState(sessionId, { ownerId } = {}) {
    const session = this.getSession(sessionId, ownerId);
    return { status: 'waiting-for-files', sessionId, name: session.name,
      sourceName: path.basename(session.archivePath),
      canResume: session.missing.size === 0,
      files: [...session.missing.values()].map((file) => ({
        projectId: file.projectId, fileId: file.fileId, fileName: file.fileName,
        reason: file.reason, canImport: /^[0-9a-f]{40}$/i.test(file.sha1 ?? ''),
        officialUrl: file.officialUrl
          ?? `https://www.curseforge.com/projects/${file.projectId}/files/${file.fileId}`
      })) };
  }

  async importMissingFile(sessionId, { projectId, fileId, filePath }, { ownerId, signal } = {}) {
    const session = this.getSession(sessionId, ownerId);
    if (session.busy) throw modpackError('整合包任务正在处理中', 'TASK_BUSY', 'importing-files');
    const entry = session.missing.get(`${projectId}:${fileId}`);
    if (!entry || !/^[0-9a-f]{40}$/i.test(entry.sha1 ?? '')) {
      throw modpackError('该文件尚无可信校验信息，请先重新查询', 'MODPACK_METADATA_UNAVAILABLE', 'resolving-files');
    }
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
      throw modpackError('请选择有效的本地文件', 'MODPACK_FILE_MISMATCH', 'importing-files');
    }
    session.busy = true;
    session.controller = new AbortController();
    const importSignal = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal;
    try {
      await this.verifySessionArchive(session, importSignal);
      await importModpackFile({ ...entry, signal: importSignal }, filePath,
        safePath(session.gameDirectory, 'launcher-cache', 'modpack-files'));
      for (const [key, missing] of session.missing) {
        if (missing.sha1 === entry.sha1 && missing.size === entry.size) session.missing.delete(key);
      }
      session.updatedAt = new Date().toISOString();
      await this.saveRecoverySessions();
      return this.getRecoveryState(sessionId, { ownerId });
    } finally {
      session.busy = false;
      session.controller = null;
      if (session.releaseWhenIdle) { session.ownerId = null; session.releaseWhenIdle = false; }
    }
  }

  async discardSession(sessionId, { ownerId } = {}) {
    const session = this.getSession(sessionId, ownerId);
    if (session.busy && session.cancellable === false) return { cancelled: false };
    session.controller?.abort();
    this.sessions.delete(sessionId);
    await this.saveRecoverySessions();
    return { cancelled: true };
  }

  async discardOwnerSessions(ownerId) {
    await this.loadRecoverySessions();
    for (const [sessionId, session] of this.sessions) {
      if (session.ownerId !== (ownerId ?? null)) continue;
      if (session.cancellable !== false) session.controller?.abort();
      this.sessions.delete(sessionId);
    }
    await this.saveRecoverySessions();
  }

  releaseOwnerSessions(ownerId) {
    for (const session of this.sessions.values()) {
      if (session.ownerId !== (ownerId ?? null)) continue;
      if (session.busy) {
        if (session.cancellable !== false) session.controller?.abort();
        session.releaseWhenIdle = true;
        continue;
      }
      session.ownerId = null;
      session.controller = null;
    }
  }

  async verifySessionArchive(session, signal) {
    let fingerprint;
    try { fingerprint = await archiveFingerprint(session.archivePath, signal); }
    catch (error) {
      throwIfAborted(signal);
      this.sessions.delete(session.sessionId);
      await this.saveRecoverySessions();
      throw modpackError('原整合包已移动或无法读取，请重新选择归档', 'MODPACK_ARCHIVE_CHANGED', 'preparing', false, error);
    }
    if (fingerprint !== session.fingerprint) {
      this.sessions.delete(session.sessionId);
      await this.saveRecoverySessions();
      throw modpackError('整合包归档已更改，请重新选择归档', 'MODPACK_ARCHIVE_CHANGED', 'preparing', false);
    }
  }

  async install(filePath, onProgress = () => {}, { signal, installOptionalFiles = false, ownerId } = {}) {
    throwIfAborted(signal);
    await this.loadRecoverySessions();
    const archivePath = validateModpackFile(filePath);
    const session = { sessionId: crypto.randomUUID(), archivePath, ownerId: ownerId ?? null,
      gameDirectory: path.resolve(this.gameDirectory), fingerprint: await archiveFingerprint(archivePath, signal),
      installOptionalFiles, metadata: new Map(), missing: new Map(), busy: false, cancellable: true,
      waiting: false, updatedAt: new Date().toISOString() };
    for (const [id, previous] of this.sessions) {
      if (previous.ownerId === session.ownerId && !previous.busy) this.sessions.delete(id);
    }
    this.sessions.set(session.sessionId, session);
    return this.runSession(session, onProgress, signal, true);
  }

  async resume(sessionId, onProgress = () => {}, { signal, ownerId } = {}) {
    const session = this.getSession(sessionId, ownerId);
    return this.runSession(session, onProgress, signal);
  }

  async runSession(session, onProgress, signal, initial = false) {
    if (session.busy) throw modpackError('整合包任务正在处理中', 'TASK_BUSY', 'preparing');
    session.busy = true;
    session.cancellable = true;
    session.controller = new AbortController();
    const taskSignal = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal;
    let phase = 'preparing';
    const progress = (value) => { phase = value.phase ?? phase; onProgress({ cancellable: session.cancellable, ...value }); };
    try {
      if (!initial) await this.verifySessionArchive(session, taskSignal);
      const cleanupWarnings = await cleanupStaleStaging(session.gameDirectory);
      const result = await this.performInstall(session, progress, taskSignal, cleanupWarnings);
      if (session.cancellable) throwIfAborted(taskSignal);
      if (result?.status === 'waiting-for-files') {
        session.waiting = true;
        session.updatedAt = new Date().toISOString();
        await this.saveRecoverySessions();
      } else {
        await this.saveRecoverySessions();
      }
      return result;
    } catch (error) {
      // A resumed task can fail or be cancelled after a manual file was
      // verified. Keep that recovery handle until explicitly discarded, unless
      // the archive/session is no longer trustworthy.
      if (initial || error.retryable === false) {
        this.sessions.delete(session.sessionId);
        await this.saveRecoverySessions();
      }
      error.phase ??= phase;
      throw error;
    } finally {
      session.busy = false;
      session.controller = null;
      if (session.releaseWhenIdle) { session.ownerId = null; session.releaseWhenIdle = false; }
    }
  }

  async performInstall(session, onProgress, signal, cleanupWarnings) {
    const { installOptionalFiles } = session;
    return this.withExtractedPack(session.archivePath, async ({ archivePath, packRoot, pack }) => {
      session.name = pack.name;
      const refreshMetadata = new Set([...session.missing.entries()]
        .filter(([, missing]) => missing.reason !== 'restricted').map(([key]) => key));
      session.missing.clear();
      throwIfAborted(signal);
      onProgress({ phase: 'installing-base', message: `正在准备 Minecraft ${pack.gameVersion} 与加载器…` });
      let loaderResult;
      try {
        loaderResult = await this.loaderManager.installLoader({
          gameVersion: pack.gameVersion,
          loaderType: pack.loaderType,
          loaderVersion: pack.loaderVersion
        }, (progress) => onProgress({
          ...progress,
          phase: 'installing-base',
          message: progress.message,
          modpackName: pack.name
        }), { signal });
      } catch (error) {
        throwIfAborted(signal);
        throw modpackError(`基础游戏或加载器安装失败：${error.message}`,
          error.code ?? 'MODPACK_BASE_FAILED', 'installing-base', error.retryable !== false, error);
      }

      const instanceId = `${createInstanceId(pack.name)}-${crypto.randomBytes(4).toString('hex')}`;
      const instancesRoot = safePath(this.gameDirectory, 'melody-instances');
      const instanceDirectory = safePath(instancesRoot, instanceId);
      const stagingDirectory = await createStagingDirectory(session.gameDirectory, instanceId);
      const warnings = [...cleanupWarnings];
      let committed = false;
      let primaryError;
      try {
        throwIfAborted(signal);

        let files = pack.files.filter((file) => file.required !== false || installOptionalFiles);
        if (pack.format === 'curseforge') {
          const selectedFiles = files;
          const resolved = new Array(selectedFiles.length);
          let completed = 0;
          onProgress({
            phase: 'resolving-files',
            message: `正在解析 ${selectedFiles.length} 个 CurseForge 文件…`,
            completedFiles: 0,
            totalFiles: selectedFiles.length
          });
          await runPool(selectedFiles, Math.min(this.concurrency, 8), async (entry, index, poolSignal) => {
            const key = `${entry.projectId}:${entry.fileId}`;
            try {
              let metadata = session.metadata.get(key);
              if (!metadata || !metadata.sha1 || refreshMetadata.has(key)) {
                metadata = await resolveCurseForgeMetadata(entry, poolSignal);
                session.metadata.set(key, metadata);
              }
              resolved[index] = metadata;
            } catch (error) {
              throwIfAborted(poolSignal);
              if (error.code !== 'MODPACK_METADATA_UNAVAILABLE' && !isRemoteFailure(error)) throw error;
              if (entry.required !== false) session.missing.set(key, { ...entry, reason: 'metadata-unavailable' });
              else warnings.push(error.message);
            }
            completed += 1;
            onProgress({
              phase: 'resolving-files',
              message: `正在解析 CurseForge 文件 ${completed}/${selectedFiles.length}`,
              completedFiles: completed,
              totalFiles: selectedFiles.length
            });
          }, signal);
          files = resolved.filter(Boolean);
        }

        const destinations = new Map();
        files = files.filter((file) => {
          const destinationKey = safeRelativePath(file.path).toLowerCase();
          const previous = destinations.get(destinationKey);
          if (!previous) { destinations.set(destinationKey, file); return true; }
          if (previous.sha1 && previous.sha1 === file.sha1) {
            previous.required = previous.required !== false || file.required !== false;
            return false;
          }
          throw modpackError('整合包有多个不同文件使用相同安装路径', 'MODPACK_INVALID_METADATA', 'resolving-files', false);
        });
        const tasks = files.map((file) => ({
          ...file,
          label: `整合包文件 ${file.path}`,
          destination: safePath(stagingDirectory, ...safeRelativePath(file.path).split('/')),
          urls: file.urls,
          sha1: file.sha1,
          size: file.size,
          validateRedirect: (url) => validatePublicDownloadUrl(url, this.lookupHost)
        }));
        const progressTracker = createDownloadProgressTracker({
          tasks,
          onProgress,
          phase: 'downloading-files',
          baseProgress: { modpackName: pack.name }
        });
        progressTracker.start(`准备下载 ${tasks.length} 个整合包文件`);
        const cacheRoot = safePath(this.gameDirectory, 'launcher-cache', 'modpack-files');
        await runPool(tasks, this.concurrency, async (task, _index, poolSignal) => {
          try {
            if (!task.urls.length && !(await hasCachedModpackFile({ ...task, signal: poolSignal }, cacheRoot))) {
              if (task.required === false) { warnings.push(`可选文件 ${task.fileName} 禁止自动下载，已跳过`); return; }
              session.missing.set(`${task.projectId}:${task.fileId}`, { ...task,
                reason: task.sha1 ? 'restricted' : 'metadata-unavailable' });
              return;
            }
            const result = await downloadModpackFile({
              ...task, signal: poolSignal, segmentConcurrency: this.segmentConcurrency,
              ...progressTracker.hooks(task)
            }, cacheRoot);
            progressTracker.complete(task, result);
          } catch (error) {
            throwIfAborted(poolSignal);
            if (!isRemoteFailure(error)) throw error;
            if (task.required === false) { warnings.push(`可选文件 ${task.path} 未能下载：${error.message}`); return; }
            if (pack.format !== 'curseforge') throw error;
            session.missing.set(`${task.projectId}:${task.fileId}`, { ...task, reason: 'download-failed' });
          }
        }, signal);

        throwIfAborted(signal);
        if (session.missing.size > 0) {
          onProgress({ phase: 'waiting-for-files', message: '请补齐缺失文件或重新查询后继续安装' });
          return this.getRecoveryState(session.sessionId, { ownerId: session.ownerId });
        }

        onProgress({ phase: 'copying-overrides', message: '正在复制整合包配置与覆盖文件…' });
        try {
          for (const overrideDirectory of pack.overrideDirectories) {
            throwIfAborted(signal);
            await copyDirectoryContents(
              safePath(packRoot, ...safeRelativePath(overrideDirectory).split('/')),
              stagingDirectory,
              { signal }
            );
          }
        } catch (error) {
          throwIfAborted(signal);
          throw modpackError(`覆盖文件复制失败：${error.message}`, error.code ?? 'MODPACK_COPY_FAILED', 'copying-overrides', true, error);
        }
        throwIfAborted(signal);

        const metadata = {
          schemaVersion: 1,
          instanceId,
          name: pack.name,
          packVersion: pack.version,
          format: pack.format,
          sourceFile: path.basename(archivePath),
          profileId: loaderResult.profileId,
          gameVersion: pack.gameVersion,
          loaderType: pack.loaderType,
          loaderVersion: pack.loaderVersion,
          fileCount: tasks.length,
          optionalFilesInstalled: installOptionalFiles,
          warnings,
          installedAt: new Date().toISOString()
        };
        try {
          await writeJsonAtomic(
            safePath(stagingDirectory, '.melody-instance.json'),
            metadata
          );
          throwIfAborted(signal);
          // From this synchronous boundary onward cancellation cannot undo the
          // atomic commit. Report the boundary before invoking renderer callbacks.
          session.cancellable = false;
          onProgress({ phase: 'committing-instance', message: '正在保存实例配置…', cancellable: false });
          await fs.rename(stagingDirectory, instanceDirectory);
          committed = true;
          releaseStagingDirectory(stagingDirectory);
          await fs.rm(path.join(instanceDirectory, STAGING_MARKER), { force: true }).catch(() => {});
        } catch (error) {
          if (session.cancellable !== false) throwIfAborted(signal);
          throw modpackError(`实例配置保存失败：${error.message}`, error.code ?? 'MODPACK_COMMIT_FAILED', 'committing-instance', true, error);
        }
        const result = {
          status: 'complete',
          ...publicPackInfo(pack),
          instanceId,
          targetId: `instance-${instanceId}`,
          profileId: loaderResult.profileId,
          warnings
        };
        onProgress({
          phase: 'complete',
          message: `${pack.name} 安装完成`,
          completedFiles: tasks.length,
          totalFiles: tasks.length,
          warnings,
          ...result
        });
        this.sessions.delete(session.sessionId);
        return result;
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        if (!committed) {
          try { await removeStagingDirectory(session.gameDirectory, stagingDirectory); }
          catch (cleanupError) {
            if (primaryError) {
              primaryError.details = { ...primaryError.details,
                cleanupMessage: `临时文件清理失败，将在下次启动时重试：${cleanupError.message}` };
            }
            else throw modpackError(`临时文件清理失败，将在下次启动时重试：${cleanupError.message}`,
              'MODPACK_CLEANUP_FAILED', 'cleanup', true, cleanupError);
          }
        }
      }
    }, { signal, onProgress });
  }

  async resolveLaunchTarget(targetId) {
    return require('./launch-target').resolveLaunchTarget(this.gameDirectory, targetId);
  }

}

module.exports = {
  INSTANCE_ID_PATTERN,
  MODPACK_EXTENSIONS,
  ModpackManager,
  createInstanceId,
  parseCurseForgeManifest,
  parseExtractedPack,
  parseModrinthIndex,
  publicPackInfo,
  resolveCurseForgeFile,
  resolveCurseForgeMetadata,
  copyDirectoryContents,
  safeRelativePath,
  validatePublicDownloadUrl,
  validateModpackFile
};
