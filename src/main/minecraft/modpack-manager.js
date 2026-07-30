const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createDownloadProgressTracker,
  downloadFile,
  runPool,
  safePath,
  throwIfAborted,
  writeJsonAtomic
} = require('./downloader');
const { extractNativeArchive } = require('./launch-core');
const { fetchWithTimeout } = require('./source-manager');

const MODPACK_EXTENSIONS = Object.freeze(['.mrpack', '.zip']);
const INSTANCE_ID_PATTERN = /^[0-9A-Za-z._-]{1,100}$/;

function requireVersion(value, label = 'Minecraft') {
  const version = String(value ?? '');
  if (!/^[0-9A-Za-z._+-]{1,100}$/.test(version)) {
    throw new Error(`整合包缺少有效的 ${label} 版本`);
  }
  return version;
}

function safeRelativePath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (
    !normalized
    || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => segment === '..')
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
    || hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
  ) {
    throw new Error(`整合包包含不安全的模组下载地址：${parsed.hostname}`);
  }
  return parsed.toString();
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
    throw new Error('当前版本暂不支持 Quilt 整合包');
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
    .map((file) => ({
      path: safeRelativePath(file.path),
      urls: (file.downloads ?? []).map(safeDownloadUrl),
      sha1: file.hashes?.sha1,
      size: Number.isFinite(file.fileSize) ? file.fileSize : undefined,
      required: file.env?.client !== 'optional'
    })) : [];
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
    const match = String(selected.id).match(/^(fabric|forge|neoforge)-(.+)$/i);
    if (!match) throw new Error(`暂不支持整合包加载器：${selected.id}`);
    loaderType = match[1].toLowerCase();
    loaderVersion = requireVersion(match[2], loaderType);
  }
  const files = Array.isArray(manifest.files) ? manifest.files.map((file) => {
    const projectId = Number(file.projectID);
    const fileId = Number(file.fileID);
    if (!Number.isInteger(projectId) || !Number.isInteger(fileId)) {
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
  const directories = entries.filter((entry) => entry.isDirectory());
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

async function copyDirectoryContents(source, destination) {
  let entries;
  try {
    entries = await fs.readdir(source, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    await fs.cp(
      path.join(source, entry.name),
      safePath(destination, entry.name),
      { recursive: true, force: true }
    );
  }
}

async function resolveCurseForgeFile(entry, signal) {
  const communityUrl = `https://api.curse.tools/v1/cf/mods/${entry.projectId}/files/${entry.fileId}`;
  let metadata;
  try {
    const response = await fetchWithTimeout(communityUrl, { signal }, 12000);
    if (response.ok) metadata = (await response.json()).data;
  } catch (error) {
    if (signal?.aborted) throw error;
  }

  if (!metadata && process.env.CURSEFORGE_API_KEY) {
    const response = await fetchWithTimeout(
      `https://api.curseforge.com/v1/mods/${entry.projectId}/files/${entry.fileId}`,
      { headers: { 'x-api-key': process.env.CURSEFORGE_API_KEY }, signal },
      12000
    );
    if (response.ok) metadata = (await response.json()).data;
  }
  if (!metadata?.fileName) {
    throw new Error(`无法获取 CurseForge 文件信息（项目 ${entry.projectId}，文件 ${entry.fileId}），文件可能已下架或接口暂时不可用`);
  }
  if (!metadata.downloadUrl) {
    throw new Error(`CurseForge 文件禁止第三方自动下载（项目 ${entry.projectId}，文件 ${entry.fileId}），请从整合包发布页手动获取`);
  }
  const sha1 = metadata.hashes?.find((hash) => Number(hash.algo) === 1)?.value;
  return {
    path: `mods/${metadata.fileName}`,
    urls: [safeDownloadUrl(metadata.downloadUrl)],
    sha1,
    size: Number.isFinite(metadata.fileLength) ? metadata.fileLength : undefined
  };
}

class ModpackManager {
  constructor({ gameDirectory, loaderManager, concurrency = 16, segmentConcurrency = 8 }) {
    this.gameDirectory = gameDirectory;
    this.loaderManager = loaderManager;
    this.concurrency = concurrency;
    this.segmentConcurrency = segmentConcurrency;
  }

  async withExtractedPack(filePath, operation) {
    const archivePath = validateModpackFile(filePath);
    const stat = await fs.stat(archivePath);
    if (!stat.isFile()) throw new Error('拖入的整合包文件无效');
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-'));
    try {
      await extractNativeArchive(archivePath, temporaryRoot);
      const parsed = await parseExtractedPack(temporaryRoot);
      return await operation({ archivePath, ...parsed });
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  inspect(filePath) {
    return this.withExtractedPack(filePath, async ({ pack }) => publicPackInfo(pack));
  }

  async install(filePath, onProgress = () => {}, { signal, installOptionalFiles = false } = {}) {
    return this.withExtractedPack(filePath, async ({ archivePath, packRoot, pack }) => {
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
        throw new Error(`基础游戏或加载器安装失败：${error.message}`);
      }

      const instanceId = createInstanceId(pack.name);
      const instancesRoot = safePath(this.gameDirectory, 'melody-instances');
      const instanceDirectory = safePath(instancesRoot, instanceId);
      const stagingDirectory = safePath(instancesRoot, `.installing-${instanceId}`);
      await fs.mkdir(stagingDirectory, { recursive: true });
      const warnings = [];
      try {
        onProgress({ phase: 'copying-overrides', message: '正在复制整合包配置与覆盖文件…' });
        try {
          for (const overrideDirectory of pack.overrideDirectories) {
            throwIfAborted(signal);
            await copyDirectoryContents(
              safePath(packRoot, ...safeRelativePath(overrideDirectory).split('/')),
              stagingDirectory
            );
          }
        } catch (error) {
          throw new Error(`覆盖文件复制失败：${error.message}`);
        }
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
          await runPool(selectedFiles, Math.min(this.concurrency, 8), async (entry, index) => {
            try {
              resolved[index] = await resolveCurseForgeFile(entry, signal);
            } catch (error) {
              if (entry.required !== false) {
                throw new Error(`必需文件解析失败：${error.message}`);
              }
              warnings.push(error.message);
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

        const tasks = files.map((file) => ({
          label: `整合包文件 ${file.path}`,
          destination: safePath(stagingDirectory, ...safeRelativePath(file.path).split('/')),
          urls: file.urls,
          sha1: file.sha1,
          size: file.size
        }));
        const progressTracker = createDownloadProgressTracker({
          tasks,
          onProgress,
          phase: 'downloading-files',
          baseProgress: { modpackName: pack.name }
        });
        progressTracker.start(`准备下载 ${tasks.length} 个整合包文件`);
        await runPool(tasks, this.concurrency, async (task) => {
          const result = await downloadFile({
            ...task,
            signal,
            segmentConcurrency: this.segmentConcurrency,
            ...progressTracker.hooks(task)
          });
          progressTracker.complete(task, result);
        }, signal);

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
        onProgress({ phase: 'committing-instance', message: '正在保存实例配置…' });
        try {
          await writeJsonAtomic(
            safePath(stagingDirectory, '.melody-instance.json'),
            metadata
          );
          await fs.mkdir(instancesRoot, { recursive: true });
          await fs.rename(stagingDirectory, instanceDirectory);
        } catch (error) {
          throw new Error(`实例配置保存失败：${error.message}`);
        }
        const result = {
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
        return result;
      } catch (error) {
        await fs.rm(stagingDirectory, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async resolveLaunchTarget(targetId) {
    const value = String(targetId ?? '');
    if (!value.startsWith('instance-')) return undefined;
    const instanceId = value.slice('instance-'.length);
    if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new Error('整合包实例 ID 无效');
    const instanceDirectory = safePath(this.gameDirectory, 'melody-instances', instanceId);
    const metadata = await readJson(safePath(instanceDirectory, '.melody-instance.json'));
    if (!metadata || metadata.schemaVersion !== 1 || metadata.instanceId !== instanceId) {
      throw new Error('整合包实例不存在或配置已损坏');
    }
    return {
      instanceDirectory,
      instanceId,
      name: metadata.name,
      profileId: metadata.profileId,
      targetId: value
    };
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
  safeRelativePath,
  validateModpackFile
};
