const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { SOURCES, fetchWithTimeout } = require('./source-manager');

const fsPromises = fs.promises;
const DEFAULT_FILE_CONCURRENCY = 32;
const DEFAULT_SEGMENT_CONCURRENCY = 8;
const SEGMENT_THRESHOLD_BYTES = 4 * 1024 * 1024;
const MIN_SEGMENT_SIZE_BYTES = 1 * 1024 * 1024;
const DEFAULT_SLOW_GRACE_MS = 10000;
const DEFAULT_SLOW_THRESHOLD_BYTES_PER_SECOND = 96 * 1024;
const DEFAULT_SLOW_CHECK_INTERVAL_MS = 1000;
const DEFAULT_SLOW_MINIMUM_SIZE = 2 * 1024 * 1024;
const INSTALLATION_MARKER_FILE = '.melody-installed.json';

function sourceDetailsFromUrl(url) {
  let sourceId = 'official';
  let sourceLabel = SOURCES.official.label;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname.includes('bmclapi') || hostname.endsWith('bangbang93.com')) {
      sourceId = 'bmclapi';
      sourceLabel = SOURCES.bmclapi.label;
    } else if (hostname.endsWith('littleservice.cn')) {
      sourceId = 'lss233';
      sourceLabel = "Lss233's Mirror";
    }
  } catch {}
  return {
    sourceId,
    sourceLabel,
    url
  };
}

function createTransferMonitor(task, controller, canSwitchSource) {
  const minimumSize = task.slowMinimumSize ?? DEFAULT_SLOW_MINIMUM_SIZE;
  const enabled = canSwitchSource && (
    !Number.isFinite(task.size) || task.size >= minimumSize
  );
  const graceMs = task.slowGraceMs ?? DEFAULT_SLOW_GRACE_MS;
  const threshold = task.slowThresholdBytesPerSecond
    ?? DEFAULT_SLOW_THRESHOLD_BYTES_PER_SECOND;
  const intervalMs = task.slowCheckIntervalMs ?? DEFAULT_SLOW_CHECK_INTERVAL_MS;
  const windowMs = Math.max(intervalMs * 2, Math.min(5000, graceMs));
  let startedAt = Date.now();
  const samples = [{ at: startedAt, bytes: 0 }];
  let bytes = 0;
  let slow = false;

  const timer = enabled ? setInterval(() => {
    const now = Date.now();
    samples.push({ at: now, bytes });
    while (samples.length > 2 && samples[1].at < now - windowMs) samples.shift();
    if (now - startedAt < graceMs) return;
    const baseline = samples[0];
    const elapsedSeconds = Math.max(0.001, (now - baseline.at) / 1000);
    const bytesPerSecond = (bytes - baseline.bytes) / elapsedSeconds;
    if (bytesPerSecond < threshold) {
      slow = true;
      controller.abort();
    }
  }, intervalMs) : undefined;
  timer?.unref?.();

  return {
    addBytes(length) {
      bytes += length;
      task.onBytes?.(bytes);
    },
    get bytes() {
      return bytes;
    },
    get slow() {
      return slow;
    },
    get averageBytesPerSecond() {
      return Math.round(bytes / Math.max(0.001, (Date.now() - startedAt) / 1000));
    },
    reset() {
      bytes = 0;
      startedAt = Date.now();
      samples.splice(0, samples.length, { at: startedAt, bytes: 0 });
      task.onBytes?.(0);
    },
    stop() {
      if (timer) clearInterval(timer);
    }
  };
}

function createAbortError() {
  const error = new Error('下载已取消');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function isAbortError(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

function platformName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function ruleMatches(rule) {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== platformName()) {
      return false;
    }

    if (rule.os.arch) {
      try {
        if (!new RegExp(rule.os.arch).test(process.arch)) {
          return false;
        }
      } catch {
        return false;
      }
    }
  }

  if (rule.features) {
    return Object.values(rule.features).every((required) => required === false);
  }

  return true;
}

function isLibraryAllowed(library) {
  if (!library.rules?.length) {
    return true;
  }

  let allowed = false;
  for (const rule of library.rules) {
    if (ruleMatches(rule)) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

function mavenPathFromName(name) {
  const [group, artifact, version, classifier] = name.split(':');
  if (!group || !artifact || !version) {
    return undefined;
  }

  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${group.replaceAll('.', '/')}/${artifact}/${version}/${fileName}`;
}

function nativeClassifier(library) {
  const template = library.natives?.[platformName()];
  if (!template) {
    return undefined;
  }
  const architecture = process.arch === 'ia32' ? '32' : '64';
  return template.replace('${arch}', architecture);
}

function safePath(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('下载目标路径不安全');
  }
  return resolvedTarget;
}

function installationMarkerPath(gameDirectory, profileId) {
  return safePath(gameDirectory, 'versions', profileId, INSTALLATION_MARKER_FILE);
}

function markerEntry(gameDirectory, task) {
  const root = path.resolve(gameDirectory);
  const destination = path.resolve(task.destination);
  const relativePath = path.relative(root, destination);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('安装标记包含不安全的文件路径');
  }
  return {
    label: task.label,
    path: relativePath.split(path.sep).join('/'),
    sha1: task.sha1,
    size: Number.isFinite(task.size) ? task.size : undefined
  };
}

async function writeInstallationMarker(gameDirectory, profileId, tasks = []) {
  const files = deduplicateTasks(tasks).map((task) => markerEntry(gameDirectory, task));
  await writeJsonAtomic(installationMarkerPath(gameDirectory, profileId), {
    schemaVersion: 1,
    profileId,
    completedAt: new Date().toISOString(),
    files
  });
}

async function hasValidInstallationMarker(gameDirectory, profileId) {
  try {
    const marker = JSON.parse(await fsPromises.readFile(
      installationMarkerPath(gameDirectory, profileId),
      'utf8'
    ));
    if (marker.schemaVersion !== 1 || marker.profileId !== profileId || !Array.isArray(marker.files)) {
      return false;
    }

    let valid = true;
    await runPool(marker.files, 8, async (entry) => {
      if (!valid || typeof entry.path !== 'string') {
        valid = false;
        return;
      }
      const destination = safePath(gameDirectory, ...entry.path.split('/'));
      if (!(await fileMatches(destination, { size: entry.size }))) valid = false;
    });
    return valid;
  } catch {
    return false;
  }
}

async function hasInstallationMarker(gameDirectory, profileId) {
  try {
    const marker = JSON.parse(await fsPromises.readFile(
      installationMarkerPath(gameDirectory, profileId),
      'utf8'
    ));
    return marker.schemaVersion === 1
      && marker.profileId === profileId
      && Array.isArray(marker.files);
  } catch {
    return false;
  }
}

async function fileSha1(filePath, signal) {
  const hash = crypto.createHash('sha1');
  for await (const chunk of fs.createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function fileMatches(filePath, options = {}) {
  const { sha1, size, signal } = options;
  try {
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) return false;
    if (!sha1 && !Number.isFinite(size) && stat.size === 0) return false;
    if (Number.isFinite(size) && stat.size !== size) return false;
    if (sha1 && (await fileSha1(filePath, signal)) !== sha1) return false;
    return true;
  } catch (error) {
    if (isAbortError(error, signal)) throw createAbortError();
    return false;
  }
}

async function writeJsonAtomic(destination, value) {
  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  await fsPromises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsPromises.rm(destination, { force: true });
  await fsPromises.rename(temporary, destination);
}

function createDownloadSegments(
  totalSize,
  concurrency = DEFAULT_SEGMENT_CONCURRENCY,
  minSegmentSize = MIN_SEGMENT_SIZE_BYTES
) {
  if (!Number.isFinite(totalSize) || totalSize <= 0) return [];
  const segmentCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    Math.max(1, Math.ceil(totalSize / Math.max(1, minSegmentSize)))
  );
  const segmentSize = Math.ceil(totalSize / segmentCount);
  return Array.from({ length: segmentCount }, (_value, index) => {
    const start = index * segmentSize;
    return {
      index,
      start,
      end: Math.min(totalSize - 1, start + segmentSize - 1)
    };
  }).filter((segment) => segment.start <= segment.end);
}

async function supportsRangeDownloads(url, totalSize, signal) {
  throwIfAborted(signal);
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Range: 'bytes=0-0',
        'Accept-Encoding': 'identity'
      },
      signal
    }, 20000);
    const contentRange = response.headers.get('content-range') ?? '';
    const supported = response.status === 206 && contentRange.endsWith(`/${totalSize}`);
    if (response.body) await response.body.cancel().catch(() => {});
    return supported;
  } catch (error) {
    if (isAbortError(error, signal)) throw createAbortError();
    return false;
  }
}

async function downloadSegment(url, segment, destination, signal, onChunk) {
  throwIfAborted(signal);
  const response = await fetchWithTimeout(url, {
    headers: {
      Range: `bytes=${segment.start}-${segment.end}`,
      'Accept-Encoding': 'identity'
    },
    signal
  }, 30000);
  if (response.status !== 206 || !response.body) {
    throw new Error(`服务器不支持分段请求：HTTP ${response.status}`);
  }

  const readable = Readable.fromWeb(response.body);
  readable.on('data', (chunk) => onChunk?.(chunk.length));
  await pipeline(
    readable,
    fs.createWriteStream(destination),
    { signal }
  );
  const stat = await fsPromises.stat(destination);
  if (stat.size !== segment.end - segment.start + 1) {
    throw new Error('分段大小校验失败');
  }
}

async function downloadFileSegmented(url, temporary, task) {
  const segments = createDownloadSegments(task.size, task.segmentConcurrency);
  if (segments.length < 2 || !(await supportsRangeDownloads(url, task.size, task.signal))) {
    return undefined;
  }

  const chunkPaths = segments.map((segment) => `${temporary}.chunk-${segment.index}`);
  try {
    await runPool(segments, segments.length, async (segment) => {
      await fsPromises.rm(chunkPaths[segment.index], { force: true });
      await downloadSegment(
        url,
        segment,
        chunkPaths[segment.index],
        task.signal,
        task.onChunk
      );
    }, task.signal);

    await fsPromises.rm(temporary, { force: true });
    for (const chunkPath of chunkPaths) {
      throwIfAborted(task.signal);
      await pipeline(
        fs.createReadStream(chunkPath),
        fs.createWriteStream(temporary, { flags: 'a' }),
        { signal: task.signal }
      );
    }
    return { segmented: true, segments: segments.length };
  } finally {
    await Promise.all(chunkPaths.map((chunkPath) => fsPromises.rm(chunkPath, { force: true })));
  }
}

async function downloadFile(task) {
  throwIfAborted(task.signal);
  if (await fileMatches(task.destination, task)) {
    return { skipped: true, bytes: task.size ?? 0, url: undefined, segmented: false, segments: 0 };
  }

  await fsPromises.mkdir(path.dirname(task.destination), { recursive: true });
  const temporary = `${task.destination}.part`;
  const errors = [];

  for (let urlIndex = 0; urlIndex < task.urls.length; urlIndex += 1) {
    const url = task.urls[urlIndex];
    const nextUrl = task.urls[urlIndex + 1];
    const attemptController = new AbortController();
    const signals = [task.signal, attemptController.signal].filter(Boolean);
    const attemptSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const monitor = createTransferMonitor(task, attemptController, Boolean(nextUrl));
    const currentSource = sourceDetailsFromUrl(url);
    task.onBytes?.(0);
    task.onSourceChange?.(currentSource);

    try {
      throwIfAborted(task.signal);
      await fsPromises.rm(temporary, { force: true });
      let segmentResult;
      if (Number.isFinite(task.size) && task.size >= SEGMENT_THRESHOLD_BYTES) {
        try {
          segmentResult = await downloadFileSegmented(url, temporary, {
            ...task,
            signal: attemptSignal,
            onChunk: (length) => monitor.addBytes(length)
          });
        } catch (error) {
          if (task.signal?.aborted || monitor.slow) throw error;
          await fsPromises.rm(temporary, { force: true });
          monitor.reset();
        }
      }

      if (!segmentResult) {
        const response = await fetchWithTimeout(url, { signal: attemptSignal }, 20000);
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const readable = Readable.fromWeb(response.body);
        readable.on('data', (chunk) => monitor.addBytes(chunk.length));
        await pipeline(
          readable,
          fs.createWriteStream(temporary),
          { signal: attemptSignal }
        );
      }

      throwIfAborted(task.signal);
      if (!(await fileMatches(temporary, task))) {
        throw new Error('文件校验失败');
      }

      const stat = await fsPromises.stat(temporary);
      await fsPromises.rm(task.destination, { force: true });
      await fsPromises.rename(temporary, task.destination);
      return {
        skipped: false,
        bytes: stat.size,
        url,
        sourceId: currentSource.sourceId,
        sourceLabel: currentSource.sourceLabel,
        segmented: segmentResult?.segmented === true,
        segments: segmentResult?.segments ?? 0
      };
    } catch (error) {
      await fsPromises.rm(temporary, { force: true });
      if (task.signal?.aborted) throw createAbortError();
      if (monitor.slow && nextUrl) {
        const nextSource = sourceDetailsFromUrl(nextUrl);
        task.onBytes?.(0);
        task.onSourceSwitch?.({
          ...currentSource,
          nextSourceId: nextSource.sourceId,
          nextSourceLabel: nextSource.sourceLabel,
          nextUrl,
          reason: 'slow',
          bytesPerSecond: monitor.averageBytesPerSecond
        });
        errors.push(`${url}: 下载速度持续过慢，已切换备用源`);
        continue;
      }
      if (isAbortError(error)) {
        errors.push(`${url}: 下载连接已中止`);
        continue;
      }
      errors.push(`${url}: ${error.message}`);
    } finally {
      monitor.stop();
    }
  }

  throw new Error(`下载失败 ${task.label}\n${errors.join('\n')}`);
}

async function runPool(items, concurrency, worker, signal) {
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      throwIfAborted(signal);
      const itemIndex = cursor;
      cursor += 1;
      await worker(items[itemIndex], itemIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), Math.max(items.length, 1)) },
    () => runWorker()
  );
  await Promise.all(workers);
}

function libraryTasks(metadata, gameDirectory, sourceManager, preferredSourceId) {
  const tasks = [];
  const librariesRoot = safePath(gameDirectory, 'libraries');

  for (const library of metadata.libraries ?? []) {
    if (!isLibraryAllowed(library)) {
      continue;
    }

    let artifact = library.downloads?.artifact;
    if (!artifact) {
      const fallbackPath = mavenPathFromName(library.name);
      if (fallbackPath) {
        const baseUrl = library.url ?? 'https://libraries.minecraft.net/';
        artifact = {
          path: fallbackPath,
          url: new URL(fallbackPath, baseUrl).toString(),
          sha1: library.sha1,
          size: library.size
        };
      }
    }

    if (artifact?.path && artifact.url) {
      tasks.push({
        label: `依赖库 ${library.name}`,
        destination: safePath(librariesRoot, artifact.path),
        urls: sourceManager.getCandidateUrls(
          'library',
          { originalUrl: artifact.url, path: artifact.path },
          preferredSourceId
        ),
        sha1: artifact.sha1,
        size: artifact.size
      });
    }

    const classifierName = nativeClassifier(library);
    const classifier = classifierName ? library.downloads?.classifiers?.[classifierName] : undefined;
    if (classifier?.path && classifier.url) {
      tasks.push({
        label: `原生库 ${library.name}`,
        destination: safePath(librariesRoot, classifier.path),
        urls: sourceManager.getCandidateUrls(
          'library',
          { originalUrl: classifier.url, path: classifier.path },
          preferredSourceId
        ),
        sha1: classifier.sha1,
        size: classifier.size
      });
    }
  }

  return tasks;
}

function assetTasks(assetIndex, gameDirectory, sourceManager, preferredSourceId) {
  const objectsRoot = safePath(gameDirectory, 'assets', 'objects');
  const tasks = [];

  for (const [logicalName, asset] of Object.entries(assetIndex.objects ?? {})) {
    if (!/^[a-f0-9]{40}$/i.test(asset.hash)) {
      continue;
    }

    tasks.push({
      label: `资源 ${logicalName}`,
      destination: safePath(objectsRoot, asset.hash.slice(0, 2), asset.hash),
      urls: sourceManager.getCandidateUrls('asset', { hash: asset.hash }, preferredSourceId),
      sha1: asset.hash,
      size: asset.size
    });
  }

  return tasks;
}

function deduplicateTasks(tasks) {
  return [...new Map(tasks.map((task) => [task.destination, task])).values()];
}

async function materializeLegacyAssets(assetIndex, assetIndexId, gameDirectory, signal) {
  const targets = [];
  if (assetIndex.virtual) {
    targets.push(safePath(gameDirectory, 'assets', 'virtual', assetIndexId));
  }
  if (assetIndex.map_to_resources) {
    targets.push(safePath(gameDirectory, 'resources'));
  }

  for (const targetRoot of targets) {
    for (const [logicalName, asset] of Object.entries(assetIndex.objects ?? {})) {
      throwIfAborted(signal);
      const source = safePath(
        gameDirectory,
        'assets',
        'objects',
        asset.hash.slice(0, 2),
        asset.hash
      );
      const destination = safePath(targetRoot, logicalName);
      await fsPromises.mkdir(path.dirname(destination), { recursive: true });
      await fsPromises.copyFile(source, destination);
    }
  }
}

function createDownloadProgressTracker({
  tasks,
  onProgress,
  phase = 'downloading',
  baseProgress = {},
  initialSourceId,
  emitIntervalMs = 220
}) {
  const taskBytes = new Map(tasks.map((task) => [task.destination, 0]));
  const totalBytes = tasks.reduce((sum, task) => sum + (task.size ?? 0), 0);
  let completedFiles = 0;
  let completedBytes = 0;
  let networkBytes = 0;
  let lastEmitAt = 0;
  let currentSourceId = initialSourceId;
  let currentSourceLabel = SOURCES[initialSourceId]?.label;
  const speedSamples = [{ at: Date.now(), bytes: 0 }];

  function updateSpeedSamples(now) {
    speedSamples.push({ at: now, bytes: networkBytes });
    while (speedSamples.length > 2 && speedSamples[1].at < now - 5000) speedSamples.shift();
    const baseline = speedSamples[0];
    const elapsedSeconds = Math.max(0.001, (now - baseline.at) / 1000);
    return (networkBytes - baseline.bytes) / elapsedSeconds;
  }

  function emit(message, { force = false, extra = {} } = {}) {
    const now = Date.now();
    if (!force && now - lastEmitAt < emitIntervalMs) return;
    lastEmitAt = now;
    const bytesPerSecond = updateSpeedSamples(now);
    const remainingBytes = Math.max(0, totalBytes - completedBytes);
    const etaSeconds = bytesPerSecond > 1024 && totalBytes > 0
      ? Math.ceil(remainingBytes / bytesPerSecond)
      : undefined;
    onProgress({
      phase,
      message,
      ...baseProgress,
      source: currentSourceId,
      sourceLabel: currentSourceLabel,
      completedFiles,
      totalFiles: tasks.length,
      completedBytes,
      totalBytes,
      bytesPerSecond: Math.round(bytesPerSecond),
      etaSeconds,
      ...extra
    });
  }

  function setTaskBytes(task, absoluteBytes, countAsNetwork = true) {
    const previous = taskBytes.get(task.destination) ?? 0;
    const normalized = Math.max(0, Number(absoluteBytes) || 0);
    taskBytes.set(task.destination, normalized);
    completedBytes = Math.max(0, completedBytes + normalized - previous);
    if (countAsNetwork && normalized >= previous) networkBytes += normalized - previous;
  }

  return {
    start(message) {
      emit(message, { force: true });
    },
    hooks(task) {
      return {
        onBytes: (bytes) => {
          setTaskBytes(task, bytes);
          emit(task.label);
        },
        onSourceChange: (source) => {
          currentSourceId = source.sourceId;
          currentSourceLabel = source.sourceLabel;
          emit(task.label);
        },
        onSourceSwitch: (source) => {
          currentSourceId = source.nextSourceId;
          currentSourceLabel = source.nextSourceLabel;
          emit('当前线路速度过慢，正在切换备用线路…', {
            force: true,
            extra: { sourceSwitch: true }
          });
        }
      };
    },
    complete(task, result, message) {
      setTaskBytes(
        task,
        Number.isFinite(task.size) ? task.size : result.bytes,
        result.skipped !== true
      );
      completedFiles += 1;
      if (result.sourceId) {
        currentSourceId = result.sourceId;
        currentSourceLabel = result.sourceLabel;
      }
      emit(message ?? task.label, { force: true });
    },
    snapshot() {
      return { completedFiles, totalFiles: tasks.length, completedBytes, totalBytes };
    }
  };
}

class MinecraftDownloader {
  constructor({
    gameDirectory,
    sourceManager,
    concurrency = DEFAULT_FILE_CONCURRENCY,
    segmentConcurrency = DEFAULT_SEGMENT_CONCURRENCY
  }) {
    this.gameDirectory = gameDirectory;
    this.sourceManager = sourceManager;
    this.concurrency = concurrency;
    this.segmentConcurrency = segmentConcurrency;
  }

  async listVersions({ force = false } = {}) {
    const { manifest, source } = await this.sourceManager.getVersionManifest({ force });
    let localVersionIds = new Set();
    try {
      const versionEntries = await fsPromises.readdir(
        safePath(this.gameDirectory, 'versions'),
        { withFileTypes: true }
      );
      localVersionIds = new Set(
        versionEntries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      );
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const versions = await Promise.all(manifest.versions.map(async (version) => {
      const localFilesPresent = localVersionIds.has(version.id);
      return {
        id: version.id,
        type: version.type,
        releaseTime: version.releaseTime,
        installed: localFilesPresent
          ? await hasInstallationMarker(this.gameDirectory, version.id)
          : false,
        localFilesPresent
      };
    }));

    return {
      latest: manifest.latest,
      source: {
        id: source.id,
        label: source.label,
        latency: source.latency
      },
      gameDirectory: this.gameDirectory,
      versions
    };
  }

  async verifyVersion(versionId, onProgress = () => {}, { signal } = {}) {
    throwIfAborted(signal);
    if (!/^[0-9A-Za-z._-]{1,80}$/.test(versionId)) {
      throw new Error('Minecraft 版本号格式无效');
    }

    const versionRoot = safePath(this.gameDirectory, 'versions', versionId);
    const metadataPath = safePath(versionRoot, `${versionId}.json`);
    let metadata;
    try {
      metadata = JSON.parse(await fsPromises.readFile(metadataPath, 'utf8'));
    } catch {
      await fsPromises.rm(installationMarkerPath(this.gameDirectory, versionId), { force: true });
      return {
        versionId,
        complete: false,
        checkedFiles: 1,
        totalFiles: 1,
        missingCount: 1,
        missingFiles: ['版本配置文件']
      };
    }

    const requiredTasks = [{
      label: '版本配置文件',
      destination: metadataPath
    }];
    if (metadata.downloads?.client) {
      requiredTasks.push({
        label: `Minecraft ${versionId} 客户端`,
        destination: safePath(versionRoot, `${versionId}.jar`),
        sha1: metadata.downloads.client.sha1,
        size: metadata.downloads.client.size
      });
    } else {
      requiredTasks.push({
        label: `Minecraft ${versionId} 客户端`,
        destination: safePath(versionRoot, `${versionId}.jar`)
      });
    }

    const logFile = metadata.logging?.client?.file;
    if (logFile?.id) {
      requiredTasks.push({
        label: '日志配置',
        destination: safePath(this.gameDirectory, 'assets', 'log_configs', logFile.id),
        sha1: logFile.sha1,
        size: logFile.size
      });
    }
    requiredTasks.push(...libraryTasks(metadata, this.gameDirectory, this.sourceManager, 'official'));

    let assetIndexInvalid = false;
    const assetIndexId = metadata.assetIndex?.id ?? metadata.assets;
    if (assetIndexId) {
      const assetIndexPath = safePath(
        this.gameDirectory,
        'assets',
        'indexes',
        `${assetIndexId}.json`
      );
      requiredTasks.push({ label: '资源索引', destination: assetIndexPath });
      try {
        const assetIndex = JSON.parse(await fsPromises.readFile(assetIndexPath, 'utf8'));
        requiredTasks.push(...assetTasks(
          assetIndex,
          this.gameDirectory,
          this.sourceManager,
          'official'
        ));
      } catch {
        assetIndexInvalid = true;
      }
    }

    const verificationTasks = deduplicateTasks(requiredTasks);
    const missing = assetIndexInvalid ? ['资源索引损坏或缺失'] : [];
    let checkedFiles = 0;
    let lastProgressAt = 0;
    onProgress({ versionId, checkedFiles, totalFiles: verificationTasks.length });
    await runPool(verificationTasks, Math.min(8, this.concurrency), async (task) => {
      throwIfAborted(signal);
      if (!(await fileMatches(task.destination, { ...task, signal }))) {
        missing.push(task.label);
      }
      checkedFiles += 1;
      if (Date.now() - lastProgressAt >= 180 || checkedFiles === verificationTasks.length) {
        lastProgressAt = Date.now();
        onProgress({ versionId, checkedFiles, totalFiles: verificationTasks.length });
      }
    }, signal);

    const complete = missing.length === 0;
    if (complete) {
      await writeInstallationMarker(this.gameDirectory, versionId, verificationTasks);
    } else {
      await fsPromises.rm(installationMarkerPath(this.gameDirectory, versionId), { force: true });
    }
    return {
      versionId,
      complete,
      checkedFiles,
      totalFiles: verificationTasks.length,
      missingCount: missing.length,
      missingFiles: missing.slice(0, 50)
    };
  }

  async installVersion(versionId, onProgress = () => {}, { signal } = {}) {
    throwIfAborted(signal);
    if (!/^[0-9A-Za-z._-]{1,80}$/.test(versionId)) {
      throw new Error('Minecraft 版本号格式无效');
    }

    onProgress({ phase: 'preparing', message: '正在获取版本清单…', versionId });
    const { manifest, source } = await this.sourceManager.getVersionManifest();
    throwIfAborted(signal);
    const versionEntry = manifest.versions.find((version) => version.id === versionId);
    if (!versionEntry) {
      throw new Error(`未找到 Minecraft ${versionId}`);
    }

    onProgress({
      phase: 'preparing',
      message: '正在获取版本信息…',
      versionId,
      source: source.id
    });
    const metadataResult = await this.sourceManager.fetchJsonFromSources(
      'version-json',
      { versionId, originalUrl: versionEntry.url },
      source.id
    );
    throwIfAborted(signal);
    const metadata = metadataResult.data;
    let downloadSource = metadataResult.source;
    if (metadata.downloads?.client?.url) {
      onProgress({
        phase: 'preparing',
        message: this.sourceManager.downloadPreference === 'auto'
          ? '正在测试可用线路的真实下载速度…'
          : '正在准备下载…',
        versionId,
        source: this.sourceManager.downloadPreference,
        sourceLabel: this.sourceManager.downloadPreference === 'auto'
          ? '自动选择'
          : SOURCES[this.sourceManager.downloadPreference]?.label
      });
      downloadSource = await this.sourceManager.selectDownloadSource({
        versionId,
        originalUrl: metadata.downloads.client.url,
        signal
      });
    }
    const preferredSourceId = downloadSource.id;
    const versionRoot = safePath(this.gameDirectory, 'versions', versionId);
    await writeJsonAtomic(safePath(versionRoot, `${versionId}.json`), metadata);

    let assetIndex = { objects: {} };
    let assetIndexId = metadata.assetIndex?.id ?? metadata.assets;
    if (metadata.assetIndex?.url && assetIndexId) {
      onProgress({ phase: 'preparing', message: '正在获取资源索引…', versionId });
      const assetIndexResult = await this.sourceManager.fetchJsonFromSources(
        'asset-index',
        { originalUrl: metadata.assetIndex.url },
        preferredSourceId
      );
      throwIfAborted(signal);
      assetIndex = assetIndexResult.data;
      await writeJsonAtomic(
        safePath(this.gameDirectory, 'assets', 'indexes', `${assetIndexId}.json`),
        assetIndex
      );
    }

    const tasks = [];
    if (metadata.downloads?.client?.url) {
      tasks.push({
        label: `Minecraft ${versionId} 客户端`,
        destination: safePath(versionRoot, `${versionId}.jar`),
        urls: this.sourceManager.getCandidateUrls(
          'client',
          { versionId, originalUrl: metadata.downloads.client.url },
          preferredSourceId
        ),
        sha1: metadata.downloads.client.sha1,
        size: metadata.downloads.client.size
      });
    }

    const logFile = metadata.logging?.client?.file;
    if (logFile?.url && logFile.id) {
      tasks.push({
        label: '日志配置',
        destination: safePath(this.gameDirectory, 'assets', 'log_configs', logFile.id),
        urls: this.sourceManager.getCandidateUrls(
          'logging',
          { originalUrl: logFile.url },
          preferredSourceId
        ),
        sha1: logFile.sha1,
        size: logFile.size
      });
    }

    tasks.push(...libraryTasks(metadata, this.gameDirectory, this.sourceManager, preferredSourceId));
    tasks.push(...assetTasks(assetIndex, this.gameDirectory, this.sourceManager, preferredSourceId));

    const downloadTasks = deduplicateTasks(tasks);
    const progressTracker = createDownloadProgressTracker({
      tasks: downloadTasks,
      onProgress,
      phase: 'downloading',
      baseProgress: { versionId },
      initialSourceId: preferredSourceId
    });
    progressTracker.start(
      `准备下载 ${downloadTasks.length} 个文件（${this.concurrency} 路并发）`
    );

    await runPool(downloadTasks, this.concurrency, async (task) => {
      const result = await downloadFile({
        ...task,
        signal,
        segmentConcurrency: this.segmentConcurrency,
        ...progressTracker.hooks(task)
      });
      progressTracker.complete(
        task,
        result,
        result.segmented ? `${task.label} · ${result.segments} 段并行` : task.label
      );
    }, signal);

    if (assetIndexId) {
      await materializeLegacyAssets(assetIndex, assetIndexId, this.gameDirectory, signal);
    }

    const markerTasks = [
      { label: '版本配置文件', destination: safePath(versionRoot, `${versionId}.json`) },
      ...downloadTasks
    ];
    if (assetIndexId) {
      markerTasks.push({
        label: '资源索引',
        destination: safePath(this.gameDirectory, 'assets', 'indexes', `${assetIndexId}.json`)
      });
    }
    await writeInstallationMarker(this.gameDirectory, versionId, markerTasks);

    const progress = progressTracker.snapshot();
    const result = {
      versionId,
      source: preferredSourceId,
      sourceLabel: downloadSource.label,
      gameDirectory: this.gameDirectory,
      totalFiles: downloadTasks.length,
      totalBytes: progress.totalBytes
    };
    onProgress({
      phase: 'complete',
      message: `${versionId} 安装完成`,
      completedFiles: progress.totalFiles,
      completedBytes: progress.totalBytes,
      ...result
    });
    return result;
  }
}

module.exports = {
  DEFAULT_FILE_CONCURRENCY,
  DEFAULT_SEGMENT_CONCURRENCY,
  DEFAULT_SLOW_GRACE_MS,
  DEFAULT_SLOW_MINIMUM_SIZE,
  DEFAULT_SLOW_THRESHOLD_BYTES_PER_SECOND,
  INSTALLATION_MARKER_FILE,
  MinecraftDownloader,
  SEGMENT_THRESHOLD_BYTES,
  createAbortError,
  createDownloadSegments,
  createDownloadProgressTracker,
  deduplicateTasks,
  downloadFile,
  fileMatches,
  hasValidInstallationMarker,
  hasInstallationMarker,
  isLibraryAllowed,
  libraryTasks,
  mavenPathFromName,
  runPool,
  safePath,
  sourceDetailsFromUrl,
  throwIfAborted,
  writeInstallationMarker,
  writeJsonAtomic
};
