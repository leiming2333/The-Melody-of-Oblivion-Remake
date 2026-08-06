const fs = require('node:fs/promises');
const path = require('node:path');
const {
  BMCLAPI_BASE,
  SOURCES,
  fetchWithTimeout
} = require('./source-manager');
const {
  DEFAULT_FILE_CONCURRENCY,
  DEFAULT_SEGMENT_CONCURRENCY,
  createDownloadProgressTracker,
  deduplicateTasks,
  downloadFile,
  fileMatches,
  hasInstallationMarker,
  libraryTasks,
  runPool,
  safePath,
  throwIfAborted,
  writeInstallationMarker,
  writeJsonAtomic
} = require('./downloader');
const { findJavaExecutable, runJavaInstaller } = require('./java-runtime');

const FABRIC_META_BASES = Object.freeze({
  bmclapi: `${BMCLAPI_BASE}/fabric-meta/v2`,
  official: 'https://meta.fabricmc.net/v2'
});
const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net';
const NEOFORGE_MAVEN_BASE = 'https://maven.neoforged.net/releases';
const FORGE_METADATA_PATH = 'net/minecraftforge/forge/maven-metadata.xml';
const NEOFORGE_METADATA_PATH = 'net/neoforged/neoforge/maven-metadata.xml';
const LOADER_TYPES = Object.freeze(['vanilla', 'fabric', 'forge', 'neoforge']);
const VERSION_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const LOADER_METADATA_TIMEOUT_MS = 10000;

function validateGameVersion(gameVersion) {
  if (!/^[0-9A-Za-z._-]{1,80}$/.test(gameVersion)) {
    throw new Error('Minecraft 版本号格式无效');
  }
}

function validateLoaderType(loaderType) {
  if (!LOADER_TYPES.includes(loaderType)) {
    throw new Error('不支持的加载器类型');
  }
}

function parseMavenVersions(xml) {
  return [...xml.matchAll(/<version>\s*([^<\s]+)\s*<\/version>/g)].map((match) => match[1]);
}

function forgeLoaderVersions(gameVersion, versions) {
  const prefix = `${gameVersion}-`;
  return versions
    .filter((version) => version.startsWith(prefix))
    .map((version) => ({
      version: version.slice(prefix.length),
      artifactVersion: version,
      stable: !/-beta|-alpha|-rc/i.test(version)
    }))
    .sort((left, right) => VERSION_COLLATOR.compare(right.version, left.version));
}

function neoForgeVersionPrefix(gameVersion) {
  const segments = gameVersion.split('.');
  if (segments[0] === '1' && segments.length >= 3) {
    return `${segments[1]}.${segments[2]}.`;
  }
  if (segments.length >= 2) {
    return `${segments[0]}.${segments[1]}.`;
  }
  return `${gameVersion}.`;
}

function neoForgeLoaderVersions(gameVersion, versions) {
  const prefix = neoForgeVersionPrefix(gameVersion);
  return versions
    .filter((version) => version.startsWith(prefix))
    .map((version) => ({
      version,
      artifactVersion: version,
      stable: !/-beta|-alpha|-rc/i.test(version)
    }))
    .sort((left, right) => VERSION_COLLATOR.compare(right.version, left.version));
}

function forgeLoaderVersionsFromBmclapi(gameVersion, records) {
  return records
    .filter((record) => (
      record.mcversion === gameVersion &&
      record.files?.some((file) => file.category === 'installer' && file.format === 'jar')
    ))
    .map((record) => {
      const installer = record.files.find(
        (file) => file.category === 'installer' && file.format === 'jar'
      );
      return {
        version: record.version,
        artifactVersion: `${gameVersion}-${record.version}`,
        stable: !/-beta|-alpha|-rc/i.test(record.version),
        sha1: installer.hash
      };
    })
    .sort((left, right) => VERSION_COLLATOR.compare(right.version, left.version));
}

function loaderProfileCandidates(loaderType, gameVersion, loaderVersion) {
  if (loaderType === 'vanilla') return [gameVersion];
  if (loaderType === 'fabric') return [`fabric-loader-${loaderVersion}-${gameVersion}`];
  if (loaderType === 'forge') return [`${gameVersion}-forge-${loaderVersion}`];
  return [`${gameVersion}-neoforge-${loaderVersion}`, `neoforge-${loaderVersion}`];
}

function loaderArtifact(loaderType, gameVersion, loaderVersion) {
  if (loaderType === 'forge') {
    const artifactVersion = `${gameVersion}-${loaderVersion}`;
    const pathName = `net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}-installer.jar`;
    return {
      artifactVersion,
      path: pathName,
      officialUrl: `${FORGE_MAVEN_BASE}/${pathName}`
    };
  }

  if (loaderType === 'neoforge') {
    const pathName = `net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
    return {
      artifactVersion: loaderVersion,
      path: pathName,
      officialUrl: `${NEOFORGE_MAVEN_BASE}/${pathName}`
    };
  }

  throw new Error('该加载器不使用 Java 安装器');
}

async function fetchFirst(candidates, parser, signal) {
  const errors = [];
  for (const candidate of candidates) {
    try {
      throwIfAborted(signal);
      const response = await fetchWithTimeout(
        candidate.url,
        { signal },
        LOADER_METADATA_TIMEOUT_MS
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        data: await parser(response, candidate),
        source: candidate.source,
        url: candidate.url
      };
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw error;
      errors.push(`${candidate.url}: ${error.message}`);
    }
  }
  throw new Error(`加载器版本获取失败\n${errors.join('\n')}`);
}

async function fetchFastest(candidates, parser, signal) {
  throwIfAborted(signal);
  const controllers = candidates.map(() => new AbortController());
  const requests = candidates.map(async (candidate, index) => {
    const requestSignal = signal
      ? AbortSignal.any([signal, controllers[index].signal])
      : controllers[index].signal;
    try {
      const response = await fetchWithTimeout(
        candidate.url,
        { signal: requestSignal },
        LOADER_METADATA_TIMEOUT_MS
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        data: await parser(response, candidate),
        source: candidate.source,
        url: candidate.url
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`${candidate.url}: ${error.message}`, { cause: error });
    }
  });

  try {
    return await Promise.any(requests);
  } catch (error) {
    throwIfAborted(signal);
    const errors = error instanceof AggregateError
      ? error.errors.map((item) => item.message)
      : [error.message];
    throw new Error(`加载器版本获取失败\n${errors.join('\n')}`);
  } finally {
    for (const controller of controllers) controller.abort();
  }
}

class MinecraftLoaderManager {
  constructor({
    gameDirectory,
    sourceManager,
    downloader,
    concurrency = DEFAULT_FILE_CONCURRENCY,
    segmentConcurrency = DEFAULT_SEGMENT_CONCURRENCY
  }) {
    this.gameDirectory = gameDirectory;
    this.sourceManager = sourceManager;
    this.downloader = downloader;
    this.concurrency = concurrency;
    this.segmentConcurrency = segmentConcurrency;
    this.javaPath = '';
    this.cache = new Map();
    this.cacheDurationMs = 5 * 60 * 1000;
  }

  fetchMetadata(candidates, parser, signal) {
    return this.sourceManager.downloadPreference === 'auto' && candidates.length > 1
      ? fetchFastest(candidates, parser, signal)
      : fetchFirst(candidates, parser, signal);
  }

  async preferredSource() {
    try {
      return await this.sourceManager.selectSource();
    } catch {
      return SOURCES.official;
    }
  }

  sourceCandidates(urlBySource, preferredSourceId) {
    return this.sourceManager.sourceOrder(preferredSourceId).map((sourceId) => ({
      source: SOURCES[sourceId],
      url: urlBySource(sourceId)
    }));
  }

  async installedProfileIds({ requireMarker = true } = {}) {
    const versionsRoot = safePath(this.gameDirectory, 'versions');
    let entries = [];
    try {
      entries = await fs.readdir(versionsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const installed = new Set();
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const metadataPath = safePath(versionsRoot, entry.name, `${entry.name}.json`);
      const valid = requireMarker
        ? await hasInstallationMarker(this.gameDirectory, entry.name)
        : await fileMatches(metadataPath, {});
      if (valid) installed.add(entry.name);
    }));
    return installed;
  }

  findProfileId(installedIds, loaderType, gameVersion, loaderVersion) {
    const candidates = loaderProfileCandidates(loaderType, gameVersion, loaderVersion);
    const exact = candidates.find((candidate) => installedIds.has(candidate));
    if (exact) return exact;

    if (loaderType !== 'neoforge') return undefined;

    return [...installedIds].find((id) => {
      const normalized = id.toLowerCase();
      return normalized.includes('neoforge') && id.includes(loaderVersion);
    });
  }

  async listLoaderVersions(gameVersion, loaderType, { force = false } = {}) {
    validateGameVersion(gameVersion);
    validateLoaderType(loaderType);
    const cacheKey = `${loaderType}:${gameVersion}`;
    const cached = this.cache.get(cacheKey);
    if (!force && cached && Date.now() - cached.fetchedAt < this.cacheDurationMs) {
      const installedIds = await this.installedProfileIds();
      return this.withInstalledState(cached.result, installedIds);
    }

    const installedIdsPromise = this.installedProfileIds();
    if (loaderType === 'vanilla') {
      const result = {
        gameVersion,
        loaderType,
        source: { id: 'local', label: 'Minecraft' },
        versions: [{ version: gameVersion, artifactVersion: gameVersion, stable: true }]
      };
      return this.withInstalledState(result, await installedIdsPromise);
    }

    const preferred = this.sourceManager.downloadPreference === 'auto'
      ? SOURCES.official
      : await this.preferredSource();
    let fetched;
    let versions;

    if (loaderType === 'fabric') {
      fetched = await this.fetchMetadata(
        this.sourceCandidates(
          (sourceId) => `${FABRIC_META_BASES[sourceId]}/versions/loader/${encodeURIComponent(gameVersion)}`,
          preferred.id
        ),
        (response) => response.json()
      );
      versions = fetched.data.map((entry) => ({
        version: entry.loader.version,
        artifactVersion: entry.loader.version,
        stable: entry.loader.stable === true
      }));
    } else if (loaderType === 'forge') {
      fetched = await this.fetchMetadata(
        this.sourceCandidates(
          (sourceId) => sourceId === 'bmclapi'
            ? `${BMCLAPI_BASE}/forge/minecraft/${encodeURIComponent(gameVersion)}`
            : `${FORGE_MAVEN_BASE}/${FORGE_METADATA_PATH}`,
          preferred.id
        ),
        async (response, candidate) => {
          const parsed = candidate.source.id === 'bmclapi'
            ? forgeLoaderVersionsFromBmclapi(gameVersion, await response.json())
            : forgeLoaderVersions(gameVersion, parseMavenVersions(await response.text()));
          if (parsed.length === 0) throw new Error('未返回 Forge 安装器版本');
          return parsed;
        }
      );
      versions = fetched.data;
    } else {
      const metadataPath = loaderType === 'forge' ? FORGE_METADATA_PATH : NEOFORGE_METADATA_PATH;
      const officialBase = loaderType === 'forge' ? FORGE_MAVEN_BASE : NEOFORGE_MAVEN_BASE;
      fetched = await this.fetchMetadata(
        this.sourceCandidates(
          (sourceId) => sourceId === 'bmclapi'
            ? `${BMCLAPI_BASE}/maven/${metadataPath}`
            : `${officialBase}/${metadataPath}`,
          preferred.id
        ),
        (response) => response.text()
      );
      const mavenVersions = parseMavenVersions(fetched.data);
      versions = neoForgeLoaderVersions(gameVersion, mavenVersions);
    }

    const result = {
      gameVersion,
      loaderType,
      source: { id: fetched.source.id, label: fetched.source.label },
      versions
    };
    this.cache.set(cacheKey, { fetchedAt: Date.now(), result });
    return this.withInstalledState(result, await installedIdsPromise);
  }

  withInstalledState(result, installedIds) {
    const baseInstalled = installedIds.has(result.gameVersion);
    return {
      ...result,
      versions: result.versions.map((entry) => {
        const profileId = this.findProfileId(
          installedIds,
          result.loaderType,
          result.gameVersion,
          entry.version
        );
        const installed = Boolean(profileId) && baseInstalled;
        return { ...entry, installed, profileId: installed ? profileId : undefined };
      })
    };
  }

  async validateLoaderVersion(gameVersion, loaderType, loaderVersion) {
    const list = await this.listLoaderVersions(gameVersion, loaderType);
    const entry = list.versions.find((version) => version.version === loaderVersion);
    if (!entry) {
      throw new Error(`${loaderType} 不支持 Minecraft ${gameVersion}，或加载器版本不存在`);
    }
    return { entry, source: list.source };
  }

  async installFabric(gameVersion, loaderVersion, preferredSourceId, onProgress, signal) {
    throwIfAborted(signal);
    onProgress({ phase: 'preparing', message: '正在获取 Fabric 启动配置…', versionId: gameVersion });
    const fetched = await this.fetchMetadata(
      this.sourceCandidates(
        (sourceId) => `${FABRIC_META_BASES[sourceId]}/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`,
        preferredSourceId
      ),
      (response) => response.json(),
      signal
    );
    const profile = fetched.data;
    if (!/^[0-9A-Za-z._+-]{1,120}$/.test(profile.id) || profile.inheritsFrom !== gameVersion) {
      throw new Error('Fabric 返回了无效的启动配置');
    }

    const profileRoot = safePath(this.gameDirectory, 'versions', profile.id);
    await writeJsonAtomic(safePath(profileRoot, `${profile.id}.json`), profile);
    throwIfAborted(signal);
    const tasks = deduplicateTasks(
      libraryTasks(profile, this.gameDirectory, this.sourceManager, fetched.source.id)
    );
    const totalBytes = tasks.reduce((sum, task) => sum + (task.size ?? 0), 0);
    const progressTracker = createDownloadProgressTracker({
      tasks,
      onProgress,
      phase: 'downloading-loader',
      baseProgress: { versionId: profile.id, loaderType: 'fabric' },
      initialSourceId: preferredSourceId
    });
    progressTracker.start(`准备下载 ${tasks.length} 个 Fabric 文件（${this.concurrency} 路并发）`);
    await runPool(tasks, this.concurrency, async (task) => {
      const downloaded = await downloadFile({
        ...task,
        signal,
        segmentConcurrency: this.segmentConcurrency,
        ...progressTracker.hooks(task)
      });
      progressTracker.complete(
        task,
        downloaded,
        downloaded.segmented
          ? `${task.label} · ${downloaded.segments} 段并行`
          : task.label
      );
    }, signal);

    await writeInstallationMarker(this.gameDirectory, profile.id, [
      { label: 'Fabric 启动配置', destination: safePath(profileRoot, `${profile.id}.json`) },
      ...tasks
    ]);

    return { profileId: profile.id, source: fetched.source.id, totalFiles: tasks.length, totalBytes };
  }

  async installWithInstaller(
    gameVersion,
    loaderType,
    loaderVersion,
    preferredSourceId,
    expectedSha1,
    javaPath,
    onProgress,
    signal
  ) {
    throwIfAborted(signal);
    const artifact = loaderArtifact(loaderType, gameVersion, loaderVersion);
    const fileName = path.basename(artifact.path);
    const installerPath = safePath(
      this.gameDirectory,
      'launcher-cache',
      'installers',
      loaderType,
      artifact.artifactVersion,
      fileName
    );
    const installerUrls = this.sourceManager.getCandidateUrls(
      'library',
      { originalUrl: artifact.officialUrl, path: artifact.path },
      preferredSourceId
    );
    const installerTask = {
      label: `${loaderType} ${loaderVersion} 安装器`,
      destination: installerPath,
      urls: installerUrls,
      sha1: expectedSha1
    };
    const progressTracker = createDownloadProgressTracker({
      tasks: [installerTask],
      onProgress,
      phase: 'downloading-loader',
      baseProgress: { loaderType },
      initialSourceId: preferredSourceId
    });
    progressTracker.start(
      `正在下载 ${loaderType === 'forge' ? 'Forge' : 'NeoForge'} 安装器…`
    );
    const installerResult = await downloadFile({
      ...installerTask,
      signal,
      segmentConcurrency: this.segmentConcurrency,
      ...progressTracker.hooks(installerTask)
    });
    progressTracker.complete(installerTask, installerResult);
    onProgress({
      phase: 'installing-loader',
      message: '正在查找 Java 运行环境…',
      loaderType,
      completedFiles: 1,
      totalFiles: 2
    });
    const javaExecutable = await findJavaExecutable(javaPath);
    throwIfAborted(signal);
    let lastMessageAt = 0;
    await runJavaInstaller({
      javaExecutable,
      installerPath,
      gameDirectory: this.gameDirectory,
      signal,
      onOutput: (line) => {
        if (Date.now() - lastMessageAt < 250) return;
        lastMessageAt = Date.now();
        onProgress({
          phase: 'installing-loader',
          message: line,
          loaderType,
          completedFiles: 1,
          totalFiles: 2
        });
      }
    });

    const installedIds = await this.installedProfileIds({ requireMarker: false });
    const profileId = this.findProfileId(installedIds, loaderType, gameVersion, loaderVersion);
    if (!profileId) {
      throw new Error('安装器已结束，但没有找到生成的游戏版本配置');
    }
    await writeInstallationMarker(this.gameDirectory, profileId, [{
      label: `${loaderType} 启动配置`,
      destination: safePath(this.gameDirectory, 'versions', profileId, `${profileId}.json`)
    }]);
    return { profileId, source: preferredSourceId, totalFiles: 2 };
  }

  async installLoader(
    { gameVersion, loaderType, loaderVersion, javaPath },
    onProgress = () => {},
    { signal } = {}
  ) {
    throwIfAborted(signal);
    validateGameVersion(gameVersion);
    validateLoaderType(loaderType);

    if (loaderType === 'vanilla') {
      const result = await this.downloader.installVersion(gameVersion, onProgress, { signal });
      return { ...result, loaderType, loaderVersion: gameVersion, profileId: gameVersion };
    }
    if (!/^[0-9A-Za-z._+-]{1,100}$/.test(loaderVersion ?? '')) {
      throw new Error('加载器版本号格式无效');
    }

    const { entry, source } = await this.validateLoaderVersion(gameVersion, loaderType, loaderVersion);
    throwIfAborted(signal);
    onProgress({
      phase: 'preparing',
      message: `正在准备 Minecraft ${gameVersion} 原版基础文件…`,
      versionId: gameVersion,
      loaderType
    });
    const baseInstall = await this.downloader.installVersion(gameVersion, onProgress, { signal });
    const preferredDownloadSourceId = baseInstall.source ?? source.id;

    const result = loaderType === 'fabric'
      ? await this.installFabric(
        gameVersion,
        loaderVersion,
        preferredDownloadSourceId,
        onProgress,
        signal
      )
      : await this.installWithInstaller(
        gameVersion,
        loaderType,
        loaderVersion,
        preferredDownloadSourceId,
        entry.sha1,
        javaPath ?? this.javaPath,
        onProgress,
        signal
      );

    throwIfAborted(signal);
    this.cache.delete(`${loaderType}:${gameVersion}`);
    const complete = {
      ...result,
      gameVersion,
      loaderType,
      loaderVersion,
      gameDirectory: this.gameDirectory
    };
    onProgress({
      phase: 'complete',
      message: `${loaderType === 'fabric' ? 'Fabric' : loaderType === 'forge' ? 'Forge' : 'NeoForge'} ${loaderVersion} 安装完成`,
      completedFiles: result.totalFiles,
      totalFiles: result.totalFiles,
      ...complete
    });
    return complete;
  }
}

module.exports = {
  FABRIC_META_BASES,
  FORGE_METADATA_PATH,
  LOADER_TYPES,
  MinecraftLoaderManager,
  NEOFORGE_METADATA_PATH,
  forgeLoaderVersions,
  forgeLoaderVersionsFromBmclapi,
  fetchFastest,
  loaderArtifact,
  loaderProfileCandidates,
  neoForgeLoaderVersions,
  neoForgeVersionPrefix,
  parseMavenVersions
};
