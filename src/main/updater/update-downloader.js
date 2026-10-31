const fs = require('node:fs/promises');

const USER_AGENT = 'melody-of-oblivion-launcher-updater';
const DEFAULT_SEGMENT_THRESHOLD = 4 * 1024 * 1024;
const MIN_SEGMENT_SIZE = 1024 * 1024;

function downloadError(message, code) {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error('启动器更新已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
  }
}

function transferContext(options) {
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let startedAt = 0;
  const stallTimeoutMs = options.stallTimeoutMs ?? 15000;
  const graceMs = options.slowGraceMs ?? 6000;
  const windowMs = options.speedWindowMs ?? 3000;
  let lastByteAt = 0;
  let windowStartedAt = 0;
  let mode = null;
  let bytes = 0;
  let windowBytes = 0;
  let failure = null;
  const timer = setInterval(() => {
    if (!mode) return;
    const now = Date.now();
    if (now - lastByteAt >= stallTimeoutMs) {
      failure = downloadError('下载超时：服务器长时间未响应', 'STALL_SOURCE');
    } else if (mode === 'transfer' && now - windowStartedAt >= windowMs) {
      const speed = ((bytes - windowBytes) * 1000) / (now - windowStartedAt);
      if (options.enforceMinSpeed !== false && now - startedAt >= graceMs
        && speed < (options.minSpeedBytesPerSecond ?? 100 * 1024)) {
        failure = downloadError('当前下载源速度过慢', 'SLOW_SOURCE');
      }
      windowStartedAt = now;
      windowBytes = bytes;
    }
    if (failure) controller.abort();
  }, Math.max(1, Math.min(1000, stallTimeoutMs, windowMs)));
  timer.unref?.();

  return {
    signal,
    abort: () => controller.abort(),
    probe() { mode = 'probe'; lastByteAt = Date.now(); },
    endProbe() { mode = null; },
    start() {
      if (mode === 'transfer') return;
      mode = 'transfer';
      startedAt = lastByteAt = windowStartedAt = Date.now();
      bytes = windowBytes = 0;
    },
    received(length) { bytes += length; lastByteAt = Date.now(); },
    finish: () => clearInterval(timer),
    get failure() { return failure; }
  };
}

async function openResponse(url, headers, context, options) {
  const connectController = new AbortController();
  const timer = setTimeout(() => connectController.abort(), options.connectTimeoutMs ?? 10000);
  try {
    return await (options.fetchImpl ?? globalThis.fetch)(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', ...headers },
      signal: AbortSignal.any([context.signal, connectController.signal])
    });
  } catch (error) {
    if (connectController.signal.aborted && !context.signal.aborted) {
      throw downloadError('连接下载源超时', 'CONNECT_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function cancelBody(response) {
  await response.body?.cancel().catch(() => {});
}

function validRange(response, start, end, size) {
  const encoding = response.headers.get('content-encoding');
  return response.status === 206
    && response.headers.get('content-range') === `bytes ${start}-${end}/${size}`
    && (!encoding || encoding.toLowerCase() === 'identity');
}

async function readRangeProbe(response, context) {
  if (!response.body) throw downloadError('服务器未正确返回请求的分段', 'RANGE_UNSUPPORTED');
  let loaded = 0;
  context.probe();
  try {
    for await (const chunk of response.body) {
      context.received(chunk.length);
      loaded += chunk.length;
      if (loaded > 1) throw downloadError('分段探测大小不匹配', 'RANGE_UNSUPPORTED');
    }
    if (loaded !== 1) throw downloadError('分段探测大小不匹配', 'RANGE_UNSUPPORTED');
  } finally {
    context.endProbe();
  }
}

function createSegments(size, concurrency) {
  const count = Math.min(Math.max(1, Math.floor(concurrency)), Math.ceil(size / MIN_SEGMENT_SIZE));
  const length = Math.ceil(size / count);
  return Array.from({ length: count }, (_, index) => ({
    index, start: index * length, end: Math.min(size - 1, (index + 1) * length - 1)
  })).filter(({ start, end }) => start <= end);
}

async function writeAt(file, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, position + offset);
    if (result.bytesWritten === 0) throw downloadError('更新文件写入失败', 'WRITE_FAILED');
    offset += result.bytesWritten;
  }
}

async function downloadSingle(url, targetPath, onProgress, context, options, initialResponse) {
  const response = initialResponse ?? await openResponse(url, {}, context, options);
  if (response.status !== 200 || !response.body) {
    await cancelBody(response);
    throw downloadError(`下载更新失败（HTTP ${response.status}）`, 'HTTP_ERROR');
  }
  const size = options.expectedSize;
  const declaredSize = Number(response.headers.get('content-length')) || 0;
  const encoding = response.headers.get('content-encoding');
  if (size && declaredSize && (!encoding || encoding === 'identity') && declaredSize !== size) {
    await cancelBody(response);
    throw downloadError('更新文件大小不匹配', 'SIZE_MISMATCH');
  }
  const total = size || declaredSize;
  context.start();
  const file = await fs.open(targetPath, 'w');
  let loaded = 0;
  try {
    onProgress?.(0);
    for await (const chunk of response.body) {
      throwIfAborted(options.signal);
      const bytes = Buffer.from(chunk);
      context.received(bytes.length);
      if (size && loaded + bytes.length > size) throw downloadError('更新文件大小不匹配', 'SIZE_MISMATCH');
      await writeAt(file, bytes, loaded);
      loaded += bytes.length;
      onProgress?.(total ? Math.min(100, loaded / total * 100) : 0);
    }
    if (size && loaded !== size) throw downloadError('更新文件大小不匹配', 'SIZE_MISMATCH');
    return targetPath;
  } finally {
    await file.close();
  }
}

async function downloadSegments(url, targetPath, onProgress, context, options) {
  const size = options.expectedSize;
  const segments = createSegments(size, options.segmentConcurrency ?? 4);
  const digest = String(options.sha256 ?? '').replace(/^sha256:/i, '').toLowerCase();
  // Resume only inside this asset's download operation, after the caller has
  // supplied its trusted digest. The updater still verifies the complete file.
  const state = options.resumeState ?? {};
  const identity = /^[a-f\d]{64}$/.test(digest) ? `${targetPath}:${size}:${digest}:${segments.length}` : null;
  let reusable = identity && state.identity === identity && state.completed instanceof Set;
  if (reusable) {
    reusable = await fs.stat(targetPath).then(stat => stat.isFile() && stat.size === size, () => false);
  }
  if (!reusable) Object.assign(state, { identity, completed: new Set() });
  const file = await fs.open(targetPath, reusable ? 'r+' : 'w+');
  const progress = segments.map(segment => state.completed.has(segment.index) ? segment.end - segment.start + 1 : 0);
  const notify = () => onProgress?.(progress.reduce((sum, value) => sum + value, 0) / size * 100);
  try {
    if (!reusable) await file.truncate(size);
    notify();
    let firstError = null;
    await Promise.allSettled(segments.filter(segment => !state.completed.has(segment.index)).map(async (segment) => {
      try {
        const response = await openResponse(url, { Range: `bytes=${segment.start}-${segment.end}` }, context, options);
        if (!validRange(response, segment.start, segment.end, size) || !response.body) {
          await cancelBody(response);
          throw downloadError('服务器未正确返回请求的分段', 'RANGE_UNSUPPORTED');
        }
        context.start();
        const expected = segment.end - segment.start + 1;
        let loaded = 0;
        for await (const chunk of response.body) {
          throwIfAborted(options.signal);
          const bytes = Buffer.from(chunk);
          context.received(bytes.length);
          if (loaded + bytes.length > expected) throw downloadError('更新分段大小不匹配', 'RANGE_UNSUPPORTED');
          await writeAt(file, bytes, segment.start + loaded);
          loaded += bytes.length;
          progress[segment.index] = loaded;
          notify();
        }
        if (loaded !== expected) throw downloadError('更新分段大小不匹配', 'SIZE_MISMATCH');
        state.completed.add(segment.index);
      } catch (error) {
        firstError ??= error;
        context.abort();
        throw error;
      }
    }));
    if (firstError) throw firstError;
    throwIfAborted(options.signal);
    return targetPath;
  } finally {
    await file.close();
  }
}

async function downloadToFile(url, targetPath, onProgress, options = {}) {
  throwIfAborted(options.signal);
  const size = Number(options.expectedSize);
  const normalized = { ...options, expectedSize: Number.isSafeInteger(size) && size > 0 ? size : undefined };
  const segmented = normalized.expectedSize >= (options.segmentThresholdBytes ?? DEFAULT_SEGMENT_THRESHOLD)
    && (options.segmentConcurrency ?? 4) > 1;
  const context = transferContext(normalized);
  try {
    let result;
    let fullResponse;
    if (segmented) {
      const probe = await openResponse(url, { Range: 'bytes=0-0' }, context, normalized);
      if (validRange(probe, 0, 0, normalized.expectedSize)) {
        await readRangeProbe(probe, context);
        result = await downloadSegments(url, targetPath, onProgress, context, normalized);
      } else {
        if (normalized.resumeState) Object.assign(normalized.resumeState, { identity: null, completed: new Set() });
        if (probe.status === 200) fullResponse = probe;
        else await cancelBody(probe);
      }
    }
    result ??= await downloadSingle(url, targetPath, onProgress, context, normalized, fullResponse);
    throwIfAborted(options.signal);
    return result;
  } catch (error) {
    throwIfAborted(options.signal);
    if (context.failure) throw context.failure;
    if (error.code === 'RANGE_UNSUPPORTED') {
      context.finish();
      if (normalized.resumeState) Object.assign(normalized.resumeState, { identity: null, completed: new Set() });
      return downloadToFile(url, targetPath, onProgress, { ...normalized, segmentConcurrency: 1 });
    }
    throw error;
  } finally {
    context.abort();
    context.finish();
  }
}

module.exports = { downloadToFile };
