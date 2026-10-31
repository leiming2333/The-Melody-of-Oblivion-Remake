const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { SOURCES, fetchWithTimeout } = require('./source-manager');
const { platformName, rulesAllow } = require('./platform-rules');
const { validateProfileId } = require('./profile-id');
const { validateVersionMetadata, validateAssetIndex, verifyJsonBytes } = require('./metadata-schema');
const { readVersionMetadata } = require('./version-metadata');

const fsPromises = fs.promises;
const DEFAULT_FILE_CONCURRENCY = 32;
const DEFAULT_SEGMENT_CONCURRENCY = 8;
const SEGMENT_THRESHOLD_BYTES = 4 * 1024 * 1024;
const MIN_SEGMENT_SIZE_BYTES = 1 * 1024 * 1024;
const DEFAULT_SLOW_GRACE_MS = 10000;
const DEFAULT_SLOW_THRESHOLD_BYTES_PER_SECOND = 96 * 1024;
const DEFAULT_SLOW_CHECK_INTERVAL_MS = 1000;
const DEFAULT_SLOW_MINIMUM_SIZE = 2 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 15000;
const { safePath, installationMarkerPath, hasInstallationMarker, INSTALLATION_MARKER_FILE } = require('./installation-files');

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
    } else if (hostname.endsWith('mcimirror.top')) {
      sourceId = 'mcim';
      sourceLabel = 'MCIM 镜像';
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
  const slowEnabled = canSwitchSource && (
    !Number.isFinite(task.size) || task.size >= minimumSize
  );
  const graceMs = task.slowGraceMs ?? DEFAULT_SLOW_GRACE_MS;
  const threshold = task.slowThresholdBytesPerSecond
    ?? DEFAULT_SLOW_THRESHOLD_BYTES_PER_SECOND;
  const intervalMs = task.slowCheckIntervalMs ?? DEFAULT_SLOW_CHECK_INTERVAL_MS;
  const idleTimeoutMs = task.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const windowMs = Math.max(intervalMs * 2, Math.min(5000, graceMs));
  let startedAt = Date.now();
  let lastChunkAt = startedAt;
  const samples = [{ at: startedAt, bytes: 0 }];
  let bytes = 0;
  let slow = false;
  let idle = false;
  let active = true;

  const timer = setInterval(() => {
    if (!active) return;
    const now = Date.now();
    if (now - lastChunkAt >= idleTimeoutMs) {
      idle = true;
      controller.abort();
      return;
    }
    if (!slowEnabled) return;
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
  }, Math.min(intervalMs, idleTimeoutMs));
  timer?.unref?.();

  return {
    addBytes(length) {
      bytes += length;
      if (length > 0) lastChunkAt = Date.now();
      task.onBytes?.(bytes);
    },
    get bytes() {
      return bytes;
    },
    get slow() {
      return slow;
    },
    get idle() {
      return idle;
    },
    get averageBytesPerSecond() {
      return Math.round(bytes / Math.max(0.001, (Date.now() - startedAt) / 1000));
    },
    reset() {
      bytes = 0;
      startedAt = Date.now();
      lastChunkAt = startedAt;
      active = true;
      samples.splice(0, samples.length, { at: startedAt, bytes: 0 });
      task.onBytes?.(0);
    },
    pause() {
      active = false;
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

function isLibraryAllowed(library) {
  return rulesAllow(library.rules);
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
    sha256: task.sha256,
    size: Number.isFinite(task.size) ? task.size : undefined
  };
}

async function writeInstallationMarker(gameDirectory, profileId, tasks = [], { coversInheritance = false } = {}) {
  const files = deduplicateTasks(tasks).map((task) => markerEntry(gameDirectory, task));
  await writeJsonAtomic(installationMarkerPath(gameDirectory, profileId), {
    schemaVersion: 1,
    profileId,
    coversInheritance,
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
    if (marker.schemaVersion !== 1 || marker.profileId !== profileId
        || !Array.isArray(marker.files) || marker.files.length === 0) {
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


async function fileDigest(filePath, algorithm, signal) {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(filePath)) {
    throwIfAborted(signal);
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function fileMatches(filePath, options = {}) {
  const { sha1, sha256, size, signal } = options;
  try {
    const stat = await fsPromises.stat(filePath);
    if (!stat.isFile()) return false;
    if (!sha1 && !sha256 && !Number.isFinite(size) && stat.size === 0) return false;
    if (Number.isFinite(size) && stat.size !== size) return false;
    if (sha1 && (await fileDigest(filePath, 'sha1', signal)) !== String(sha1).toLowerCase()) return false;
    if (sha256 && (await fileDigest(filePath, 'sha256', signal)) !== String(sha256).toLowerCase()) return false;
    return true;
  } catch (error) {
    if (isAbortError(error, signal)) throw createAbortError();
    return false;
  }
}

async function replaceFileAtomic(temporary, destination, signal) {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    try {
      await fsPromises.rename(temporary, destination);
      return;
    } catch (error) {
      // Concurrent Windows renames and antivirus scans can hold a short-lived
      // sharing lock. Retry the rename, always retaining the previous file.
      if (process.platform !== 'win32' || attempt >= 4
        || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(10 * (2 ** attempt), undefined, { signal });
    }
  }
}

async function writeJsonAtomic(destination, value) {
  return writeBytesAtomic(destination, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

async function writeBytesAtomic(destination, bytes) {
  await fsPromises.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}-${crypto.randomUUID()}.part`;
  try {
    const file = await fsPromises.open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // A same-directory rename replaces the old file atomically. In particular,
    // never unlink the destination first: a failed rename must leave it intact.
    await replaceFileAtomic(temporary, destination);
  } finally {
    await fsPromises.rm(temporary, { force: true }).catch(() => {});
  }
}

function metadataDocument(result, integrity, validate, label) {
  // Source-manager returns the actual HTTP bytes. Minimal injected adapters
  // without integrity metadata may still supply a parsed document.
  const bytes = result.bytes ?? (integrity.sha1 === undefined && integrity.size === undefined
    ? Buffer.from(JSON.stringify(result.data), 'utf8') : undefined);
  verifyJsonBytes(bytes, integrity, label);
  const data = JSON.parse(bytes.toString('utf8'));
  validate(data);
  return { data, bytes };
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

async function supportsRangeDownloads(url, totalSize, signal, validateRedirect) {
  throwIfAborted(signal);
  try {
    const response = await fetchWithTimeout(url, {
      headers: {
        Range: 'bytes=0-0',
        'Accept-Encoding': 'identity'
      },
      signal,
      validateRedirect
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

async function downloadSegment(url, segment, destination, signal, onChunk, validateRedirect) {
  throwIfAborted(signal);
  const response = await fetchWithTimeout(url, {
    headers: {
      Range: `bytes=${segment.start}-${segment.end}`,
      'Accept-Encoding': 'identity'
    },
    signal,
    validateRedirect
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
  if (segments.length < 2 || !(await supportsRangeDownloads(url, task.size, task.signal, task.validateRedirect))) {
    return undefined;
  }

  const chunkPaths = segments.map((segment) => `${temporary}.chunk-${segment.index}`);
  try {
    await runPool(segments, segments.length, async (segment, _index, poolSignal) => {
      await fsPromises.rm(chunkPaths[segment.index], { force: true });
      await downloadSegment(
        url,
        segment,
        chunkPaths[segment.index],
        poolSignal,
        task.onChunk,
        task.validateRedirect
      );
    }, task.signal);

    task.onTransferComplete?.();
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
    const bytes = Number.isFinite(task.size)
      ? task.size
      : (await fsPromises.stat(task.destination)).size;
    return { skipped: true, bytes, url: undefined, segmented: false, segments: 0 };
  }

  await fsPromises.mkdir(path.dirname(task.destination), { recursive: true });
  const temporary = `${task.destination}.${process.pid}-${crypto.randomUUID()}.part`;
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
            onChunk: (length) => monitor.addBytes(length),
            onTransferComplete: () => monitor.pause()
          });
        } catch (error) {
          if (task.signal?.aborted || monitor.slow || monitor.idle) throw error;
          await fsPromises.rm(temporary, { force: true });
          monitor.reset();
        }
      }

      if (!segmentResult) {
        const response = await fetchWithTimeout(url, {
          signal: attemptSignal,
          validateRedirect: task.validateRedirect
        }, 20000);
        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const contentLength = Number(response.headers.get('content-length'));
        const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase();
        if (Number.isSafeInteger(contentLength) && contentLength > 0
          && response.status !== 206 && !response.headers.has('content-range')
          && (!contentEncoding || contentEncoding === 'identity')) {
          task.onTotalBytes?.(contentLength);
        }

        const readable = Readable.fromWeb(response.body);
        readable.on('data', (chunk) => monitor.addBytes(chunk.length));
        await pipeline(
          readable,
          fs.createWriteStream(temporary),
          { signal: attemptSignal }
        );
      }

      monitor.pause();
      throwIfAborted(task.signal);
      if (!(await fileMatches(temporary, task))) {
        throw new Error('文件校验失败');
      }

      const stat = await fsPromises.stat(temporary);
      await replaceFileAtomic(temporary, task.destination, task.signal);
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
      if ((monitor.slow || monitor.idle) && nextUrl) {
        const nextSource = sourceDetailsFromUrl(nextUrl);
        task.onBytes?.(0);
        task.onSourceSwitch?.({
          ...currentSource,
          nextSourceId: nextSource.sourceId,
          nextSourceLabel: nextSource.sourceLabel,
          nextUrl,
          reason: monitor.idle ? 'idle' : 'slow',
          bytesPerSecond: monitor.averageBytesPerSecond
        });
        errors.push(`${url}: ${monitor.idle ? '下载连接长时间无数据' : '下载速度持续过慢'}，已切换备用源`);
        continue;
      }
      if (monitor.idle) {
        errors.push(`${url}: 下载连接长时间无数据，已中止`);
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
  throwIfAborted(signal);
  const controller = new AbortController();
  const poolSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let cursor = 0;
  let failed = false;
  let failure;

  async function runWorker() {
    while (cursor < items.length && !poolSignal.aborted) {
      const itemIndex = cursor;
      cursor += 1;
      try {
        await worker(items[itemIndex], itemIndex, poolSignal);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
          controller.abort(error);
        }
        return;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), Math.max(items.length, 1)) },
    () => runWorker()
  );
  await Promise.all(workers);
  throwIfAborted(signal);
  if (failed) throw failure;
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
    let classifier = classifierName ? library.downloads?.classifiers?.[classifierName] : undefined;
    if (classifierName && !classifier) {
      const fallbackPath = mavenPathFromName(`${library.name}:${classifierName}`);
      if (fallbackPath) classifier = { path: fallbackPath,
        url: new URL(fallbackPath, library.url ?? 'https://libraries.minecraft.net/').toString() };
    }
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
  const declaredTaskSizes = new Map(tasks.map((task) => [
    task.destination,
    Number.isSafeInteger(task.size) && task.size >= 0 ? task.size : undefined
  ]));
  const taskSizes = new Map(declaredTaskSizes);
  let knownTotalBytes = 0;
  let unknownTaskSizes = 0;
  for (const size of taskSizes.values()) {
    if (size === undefined) unknownTaskSizes += 1;
    else knownTotalBytes += size;
  }
  let completedFiles = 0;
  let completedBytes = 0;
  let networkBytes = 0;
  let lastEmitAt = 0;
  let currentSourceId = initialSourceId;
  let currentSourceLabel = SOURCES[initialSourceId]?.label;
  const speedSamples = [{ at: Date.now(), bytes: 0 }];

  function totals() {
    const totalBytesKnown = unknownTaskSizes === 0 && Number.isSafeInteger(knownTotalBytes);
    return {
      totalBytesKnown,
      totalBytes: totalBytesKnown ? knownTotalBytes : 0
    };
  }

  function setTaskSize(task, size) {
    const previous = taskSizes.get(task.destination);
    if (previous === undefined) unknownTaskSizes -= 1;
    else knownTotalBytes -= previous;
    taskSizes.set(task.destination, size);
    if (size === undefined) unknownTaskSizes += 1;
    else knownTotalBytes += size;
  }

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
    const { totalBytes, totalBytesKnown } = totals();
    const remainingBytes = Math.max(0, totalBytes - completedBytes);
    const etaSeconds = totalBytesKnown && bytesPerSecond > 1024 && totalBytes > 0
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
      totalBytesKnown,
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
          if (bytes === 0 && declaredTaskSizes.get(task.destination) === undefined) {
            setTaskSize(task, undefined);
          }
          setTaskBytes(task, bytes);
          emit(task.label);
        },
        onTotalBytes: (bytes) => {
          if (declaredTaskSizes.get(task.destination) === undefined
            && Number.isSafeInteger(bytes) && bytes > 0) {
            setTaskSize(task, bytes);
            emit(task.label, { force: true });
          }
        },
        onSourceChange: (source) => {
          currentSourceId = source.sourceId;
          currentSourceLabel = source.sourceLabel;
          emit(task.label);
        },
        onSourceSwitch: (source) => {
          currentSourceId = source.nextSourceId;
          currentSourceLabel = source.nextSourceLabel;
          emit(source.reason === 'idle'
            ? '当前线路长时间无响应，正在切换备用线路…'
            : '当前线路速度过慢，正在切换备用线路…', {
            force: true,
            extra: { sourceSwitch: true }
          });
        }
      };
    },
    complete(task, result, message) {
      const bytes = declaredTaskSizes.get(task.destination) ?? result.bytes;
      if (Number.isSafeInteger(bytes) && bytes >= 0) setTaskSize(task, bytes);
      setTaskBytes(
        task,
        bytes,
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
      return { completedFiles, totalFiles: tasks.length, completedBytes, ...totals() };
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
    versionId = validateProfileId(versionId);

    let metadata;
    try {
      metadata = await readVersionMetadata(this.gameDirectory, versionId);
    } catch (error) {
      throwIfAborted(signal);
      await fsPromises.rm(installationMarkerPath(this.gameDirectory, versionId), { force: true });
      return {
        versionId,
        complete: false,
        checkedFiles: 1,
        totalFiles: 1,
        missingCount: 1,
        missingFiles: [`版本配置文件：${error.message}`]
      };
    }

    const requiredTasks = metadata.metadataChain.map((entry) => ({
      label: `版本配置文件 ${entry.profileId}`,
      destination: entry.metadataPath
    }));
    const clientJarId = metadata.clientJarId;
    const clientDestination = safePath(this.gameDirectory, 'versions', clientJarId, `${clientJarId}.jar`);
    if (metadata.clientDownload) {
      requiredTasks.push({
        label: `Minecraft ${versionId} 客户端`,
        destination: clientDestination,
        sha1: metadata.clientDownload.sha1,
        size: metadata.clientDownload.size
      });
    } else {
      requiredTasks.push({
        label: `Minecraft ${versionId} 客户端`,
        destination: clientDestination
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
      requiredTasks.push({ label: '资源索引', destination: assetIndexPath,
        sha1: metadata.assetIndex?.sha1, size: metadata.assetIndex?.size });
      try {
        const bytes = await fsPromises.readFile(assetIndexPath);
        verifyJsonBytes(bytes, metadata.assetIndex ?? {}, '资源索引');
        const assetIndex = validateAssetIndex(JSON.parse(bytes.toString('utf8')));
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
    await runPool(verificationTasks, Math.min(8, this.concurrency), async (task, _index, poolSignal) => {
      throwIfAborted(poolSignal);
      if (!(await fileMatches(task.destination, { ...task, signal: poolSignal }))) {
        if (!(assetIndexInvalid && task.label === '资源索引')) missing.push(task.label);
      }
      checkedFiles += 1;
      if (Date.now() - lastProgressAt >= 180 || checkedFiles === verificationTasks.length) {
        lastProgressAt = Date.now();
        onProgress({ versionId, checkedFiles, totalFiles: verificationTasks.length });
      }
    }, signal);

    const complete = missing.length === 0;
    if (complete) {
      await writeInstallationMarker(this.gameDirectory, versionId, verificationTasks, { coversInheritance: true });
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

  async repairVersion(profileId, onProgress = () => {}, { signal } = {}) {
    throwIfAborted(signal);
    profileId = validateProfileId(profileId);
    onProgress({ phase: 'preparing', versionId: profileId, message: '正在读取本地版本配置…' });
    let metadata;
    try {
      metadata = await readVersionMetadata(this.gameDirectory, profileId);
    } catch (cause) {
      throwIfAborted(signal);
      throw Object.assign(new Error(`启动配置缺失或损坏，无法安全补全，请重新安装该版本：${cause.message}`, { cause }),
        { code: 'GAME_METADATA_INVALID', phase: 'preparing', retryable: false });
    }
    await fsPromises.rm(installationMarkerPath(this.gameDirectory, profileId), { force: true });
    const preferredSourceId = this.sourceManager.downloadPreference === 'bmclapi' ? 'bmclapi' : 'official';
    const tasks = [];
    const clientJarId = metadata.clientJarId;
    const client = metadata.clientDownload;
    const clientTask = { label: `Minecraft ${clientJarId} 客户端`,
      destination: safePath(this.gameDirectory, 'versions', clientJarId, `${clientJarId}.jar`),
      sha1: client?.sha1, size: client?.size };
    if (client?.url) {
      tasks.push({ ...clientTask, urls: this.sourceManager.getCandidateUrls('client',
        { versionId: clientJarId, originalUrl: client.url }, preferredSourceId) });
    } else if (!(await fileMatches(clientTask.destination, { ...clientTask, signal }))) {
      throw Object.assign(new Error(`客户端 ${clientJarId} 缺少可信下载地址，请重新安装该版本`),
        { code: 'GAME_REPAIR_UNAVAILABLE', phase: 'preparing', retryable: false });
    }
    tasks.push(...libraryTasks(metadata, this.gameDirectory, this.sourceManager, preferredSourceId));
    const logging = metadata.logging?.client?.file;
    if (logging?.id) {
      const task = { label: '日志配置', destination: safePath(this.gameDirectory, 'assets', 'log_configs', logging.id),
        sha1: logging.sha1, size: logging.size };
      if (logging.url) {
        tasks.push({ ...task, urls: this.sourceManager.getCandidateUrls('logging',
          { originalUrl: logging.url }, preferredSourceId) });
      } else if (!(await fileMatches(task.destination, { ...task, signal }))) {
        throw Object.assign(new Error('日志配置缺少可信下载地址，请重新安装该版本'),
          { code: 'GAME_REPAIR_UNAVAILABLE', phase: 'preparing', retryable: false });
      }
    }

    const assetIndexId = metadata.assetIndex?.id ?? metadata.assets;
    let assetIndex = { objects: {} };
    if (assetIndexId) {
      const indexPath = safePath(this.gameDirectory, 'assets', 'indexes', `${assetIndexId}.json`);
      try {
        const bytes = await fsPromises.readFile(indexPath);
        verifyJsonBytes(bytes, metadata.assetIndex ?? {}, '资源索引');
        assetIndex = validateAssetIndex(JSON.parse(bytes.toString('utf8')));
      } catch (cause) {
        throwIfAborted(signal);
        if (cause.code && !['ENOENT', 'INVALID_MINECRAFT_METADATA'].includes(cause.code)) throw cause;
        if (!metadata.assetIndex?.url) {
          throw Object.assign(new Error('资源索引缺失或损坏，且缺少可信下载地址，请重新安装该版本', { cause }),
            { code: 'GAME_REPAIR_UNAVAILABLE', phase: 'preparing', retryable: false });
        }
        onProgress({ phase: 'preparing', versionId: profileId, message: '正在重新获取资源索引…' });
        const result = await this.sourceManager.fetchJsonFromSources('asset-index',
          { originalUrl: metadata.assetIndex.url }, preferredSourceId,
          { signal, sha1: metadata.assetIndex.sha1, size: metadata.assetIndex.size, validate: validateAssetIndex });
        throwIfAborted(signal);
        const document = metadataDocument(result, metadata.assetIndex, validateAssetIndex, '资源索引');
        await writeBytesAtomic(indexPath, document.bytes);
        assetIndex = document.data;
      }
      tasks.push(...assetTasks(assetIndex, this.gameDirectory, this.sourceManager, preferredSourceId));
    }

    const downloadTasks = deduplicateTasks(tasks);
    const tracker = createDownloadProgressTracker({ tasks: downloadTasks, onProgress,
      phase: 'downloading', baseProgress: { versionId: profileId }, initialSourceId: preferredSourceId });
    tracker.start(`正在检查并补全 ${downloadTasks.length} 个游戏文件`);
    await runPool(downloadTasks, this.concurrency, async (task, _index, poolSignal) => {
      const result = await downloadFile({ ...task, signal: poolSignal,
        segmentConcurrency: this.segmentConcurrency, ...tracker.hooks(task) });
      tracker.complete(task, result);
    }, signal);
    if (assetIndexId) await materializeLegacyAssets(assetIndex, assetIndexId, this.gameDirectory, signal);
    const verification = await this.verifyVersion(profileId, (progress) => onProgress({
      ...progress, phase: 'verifying', message: '正在验证补全后的游戏文件…'
    }), { signal });
    if (!verification.complete) {
      throw Object.assign(new Error(`补全后仍有游戏文件缺失或损坏：${verification.missingFiles.join('、')}`),
        { code: 'GAME_FILES_INCOMPLETE', phase: 'verifying', retryable: true, details: verification });
    }
    const progress = tracker.snapshot();
    onProgress({ phase: 'complete', versionId: profileId, message: `${profileId} 游戏文件补全完成`,
      completedFiles: progress.totalFiles, totalFiles: progress.totalFiles,
      completedBytes: progress.totalBytes, totalBytes: progress.totalBytes });
    return { ...verification, profileId, gameDirectory: this.gameDirectory, repaired: true };
  }

  async installVersion(versionId, onProgress = () => {}, { signal } = {}) {
    throwIfAborted(signal);
    versionId = validateProfileId(versionId);

    onProgress({ phase: 'preparing', message: '正在获取版本清单…', versionId });
    const { manifest, source } = await this.sourceManager.getVersionManifest({ signal });
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
      source.id,
      { signal, sha1: versionEntry.sha1, size: versionEntry.size,
        validate: (value) => validateVersionMetadata(value, versionId) }
    );
    throwIfAborted(signal);
    const metadataDocumentResult = metadataDocument(metadataResult, versionEntry,
      (value) => validateVersionMetadata(value, versionId), '版本配置');
    const metadata = metadataDocumentResult.data;
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
    onProgress({ phase: 'preparing', message: `已选择 ${downloadSource.label ?? preferredSourceId} 下载源`,
      versionId, sourceLabel: downloadSource.label, sourceThroughput: downloadSource.throughput,
      sourcePreference: this.sourceManager.downloadPreference });
    const versionRoot = safePath(this.gameDirectory, 'versions', versionId);
    await writeBytesAtomic(safePath(versionRoot, `${versionId}.json`), metadataDocumentResult.bytes);

    let assetIndex = { objects: {} };
    let assetIndexId = metadata.assetIndex?.id ?? metadata.assets;
    if (metadata.assetIndex?.url && assetIndexId) {
      onProgress({ phase: 'preparing', message: '正在获取资源索引…', versionId });
      const assetIndexResult = await this.sourceManager.fetchJsonFromSources(
        'asset-index',
        { originalUrl: metadata.assetIndex.url },
        preferredSourceId,
        { signal, sha1: metadata.assetIndex.sha1, size: metadata.assetIndex.size,
          validate: validateAssetIndex }
      );
      throwIfAborted(signal);
      const assetDocument = metadataDocument(assetIndexResult, metadata.assetIndex, validateAssetIndex, '资源索引');
      assetIndex = assetDocument.data;
      await writeBytesAtomic(
        safePath(this.gameDirectory, 'assets', 'indexes', `${assetIndexId}.json`),
        assetDocument.bytes
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

    await runPool(downloadTasks, this.concurrency, async (task, _index, poolSignal) => {
      const result = await downloadFile({
        ...task,
        signal: poolSignal,
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
      { label: '版本配置文件', destination: safePath(versionRoot, `${versionId}.json`),
        sha1: versionEntry.sha1, size: metadataDocumentResult.bytes.length },
      ...downloadTasks
    ];
    if (assetIndexId) {
      markerTasks.push({
        label: '资源索引',
        destination: safePath(this.gameDirectory, 'assets', 'indexes', `${assetIndexId}.json`),
        sha1: metadata.assetIndex?.sha1, size: metadata.assetIndex?.size
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
      totalBytes: progress.totalBytes,
      totalBytesKnown: progress.totalBytesKnown
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
  DEFAULT_IDLE_TIMEOUT_MS,
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
