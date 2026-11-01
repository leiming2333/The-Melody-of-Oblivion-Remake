function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function cancellation(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('下载已取消');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function checkCancelled(signal) {
  if (signal?.aborted) throw cancellation(signal);
}

function listenForAbort(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort(cancellation(signal));
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function interruptible(promise, signal) {
  if (signal.aborted) return Promise.reject(cancellation(signal));
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancellation(signal));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function cancelReader(reader) {
  try { Promise.resolve(reader?.cancel()).catch(() => {}); } catch { /* Already closed. */ }
}

function joinBytes(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function assertRange(response, start, end, size) {
  // Public Blob allows CORS reads but does not expose Content-Range. The exact
  // body length and final official digest remain mandatory in that case.
  const range = response.headers.get('content-range');
  if (range && range !== `bytes ${start}-${end}/${size}`) {
    throw failure('SIZE_MISMATCH', '下载线路返回了不正确的文件分段');
  }
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== end - start + 1)) {
    throw failure('SIZE_MISMATCH', '下载文件分段大小不正确');
  }
}

async function readRequest({ source, headers, signal, fetchImpl, connectTimeoutMs,
  stallTimeoutMs, totalTimeoutMs, inspect, sample = false, onChunk }) {
  checkCancelled(signal);
  const controller = new AbortController();
  const unlink = listenForAbort(signal, controller);
  const timeout = () => controller.abort(failure('DOWNLOAD_TIMEOUT', '下载线路连接超时或长时间没有收到数据'));
  let timer = setTimeout(timeout, connectTimeoutMs);
  const totalTimer = totalTimeoutMs ? setTimeout(timeout, totalTimeoutMs) : null;
  let reader;
  let response;
  try {
    response = await interruptible(fetchImpl(source.url, {
      headers, signal: controller.signal, mode: 'cors', credentials: 'omit'
    }), controller.signal);
    clearTimeout(timer);
    const expected = inspect(response);
    if (!response.body?.getReader) throw failure('DOWNLOAD_FAILED', '该下载线路无法读取文件内容');
    reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastDataAt = Date.now();
    for (;;) {
      const remaining = stallTimeoutMs - (Date.now() - lastDataAt);
      if (remaining <= 0) throw failure('DOWNLOAD_TIMEOUT', '下载线路长时间没有收到数据');
      timer = setTimeout(timeout, remaining);
      const { value, done } = await interruptible(reader.read(), controller.signal);
      clearTimeout(timer);
      if (done) break;
      if (!value?.byteLength) continue;
      lastDataAt = Date.now();
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (!sample && received + chunk.byteLength > expected) {
        throw failure('SIZE_MISMATCH', '下载文件超出预期大小，已停止保存');
      }
      const accepted = sample ? chunk.subarray(0, expected - received) : chunk;
      chunks.push(accepted);
      received += accepted.byteLength;
      onChunk?.(received);
      if (sample && received === expected) break;
    }
    checkCancelled(controller.signal);
    if (received !== expected) throw failure('SIZE_MISMATCH', '下载文件不完整，正在尝试其他线路');
    return { bytes: joinBytes(chunks, received), status: response.status };
  } catch (error) {
    if (controller.signal.aborted) throw cancellation(controller.signal);
    if (error.code) throw error;
    throw failure('DOWNLOAD_FAILED', '该下载线路读取失败', error);
  } finally {
    clearTimeout(timer);
    clearTimeout(totalTimer);
    unlink();
    cancelReader(reader);
    if (!reader) cancelReader(response?.body);
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure('INVALID_ASSET', `${name}无效`);
  return value;
}

/** Download to memory and return a saveable Blob only after official SHA-256 verification. */
export async function downloadReleaseAsset({
  asset, sources, signal, onProgress, fetchImpl = globalThis.fetch, autoSelect = true,
  cryptoImpl = globalThis.crypto, digestImpl,
  probeBytes = 32 * 1024, probeTimeoutMs = 3500, probeConcurrency = 2,
  segmentBytes = 1024 * 1024, concurrency = 4,
  connectTimeoutMs = 10000, stallTimeoutMs = 15000,
  slowWindowMs = 12000, slowWarmupMs = 3000, slowRatio = 0.4,
  nowImpl = () => globalThis.performance?.now() ?? Date.now()
} = {}) {
  checkCancelled(signal);
  if (!asset || typeof asset.name !== 'string' || !asset.name.trim()
    || /[\\/\u0000-\u001f]/.test(asset.name)
    || !/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '')) {
    throw failure('INVALID_ASSET', '缺少可信的安装包信息或 SHA-256，无法安全下载');
  }
  const size = positiveInteger(asset.size, '安装包大小');
  for (const [name, value] of Object.entries({ probeBytes, probeTimeoutMs, probeConcurrency,
    segmentBytes, concurrency, connectTimeoutMs, stallTimeoutMs, slowWindowMs })) positiveInteger(value, name);
  if (!Number.isFinite(slowWarmupMs) || slowWarmupMs < 0
    || !Number.isFinite(slowRatio) || slowRatio <= 0 || slowRatio > 0.5) {
    throw failure('INVALID_ASSET', '下载速度检测参数无效');
  }
  if (typeof fetchImpl !== 'function' || (!digestImpl && !cryptoImpl?.subtle?.digest)) {
    throw failure('DOWNLOAD_FAILED', '当前浏览器不支持下载校验，请使用较新的浏览器');
  }
  const seen = new Set();
  const candidates = (Array.isArray(sources) ? sources : []).flatMap((source) => {
    try {
      const url = new URL(source.url);
      if (url.protocol !== 'https:' || url.username || url.password || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ ...source, url: url.href, label: String(source.label || source.id || url.hostname) }];
    } catch { return []; }
  });
  if (!candidates.length) throw failure('NO_SOURCES', '没有可用的下载线路');
  const report = (phase, loaded, source) => {
    checkCancelled(signal);
    onProgress?.({ phase, loaded, total: size, source: source.label });
  };
  const options = { fetchImpl, connectTimeoutMs, stallTimeoutMs };

  if (autoSelect) {
    let nextProbe = 0;
    const workers = Array.from({ length: Math.min(probeConcurrency, candidates.length) }, async () => {
      while (nextProbe < candidates.length) {
        const source = candidates[nextProbe++];
        report('testing', 0, source);
        const started = nowImpl();
        const end = Math.min(probeBytes, size) - 1;
        try {
          const result = await readRequest({ ...options, source, signal,
            headers: { Range: `bytes=0-${end}` }, sample: true,
            totalTimeoutMs: probeTimeoutMs,
            inspect(response) {
              if (response.status === 206) assertRange(response, 0, end, size);
              else if (response.status !== 200) throw failure('DOWNLOAD_FAILED', '下载线路暂时不可用');
              return end + 1;
            }
          });
          source.rangeSupported = result.status === 206;
          source.probeSpeed = result.bytes.byteLength / Math.max(1, nowImpl() - started);
        } catch (error) {
          checkCancelled(signal);
          source.probeSpeed = 0;
        }
      }
    });
    await Promise.all(workers);
    candidates.sort((left, right) => (right.probeSpeed || 0) - (left.probeSpeed || 0));
  }

  const complete = new Map();
  const count = Math.ceil(size / segmentBytes);
  const completeBytes = () => [...complete.values()].reduce((sum, part) => sum + part.bytes.byteLength, 0);
  const cleanRetries = new Set();
  let lastError;

  async function fromSource(source, alternativeSpeed) {
    const controller = new AbortController();
    const unlink = listenForAbort(signal, controller);
    const inFlight = new Map();
    let received = 0;
    let firstBodyAt;
    const speedSamples = [];
    const noteBytes = (amount) => {
      received += amount;
      firstBodyAt ??= nowImpl();
    };
    // Compare the aggregate of every active stream against a measured fallback,
    // never compare one part's throughput with a whole-source speed threshold.
    const speedTimer = alternativeSpeed > 0 ? setInterval(() => {
      const now = nowImpl();
      if (firstBodyAt === undefined || now - firstBodyAt < slowWarmupMs) return;
      speedSamples.push({ at: now, received });
      while (speedSamples.length > 1 && speedSamples[1].at <= now - slowWindowMs) speedSamples.shift();
      const baseline = speedSamples[0];
      const elapsed = now - baseline.at;
      if (elapsed >= slowWindowMs && (received - baseline.received) / elapsed < alternativeSpeed * slowRatio) {
        controller.abort(failure('SOURCE_SLOW', '当前线路持续较慢，正在切换到已测通的更快线路'));
      }
    }, Math.max(1, Math.min(1000, Math.floor(slowWindowMs / 4)))) : null;
    const progress = () => report('downloading', completeBytes()
      + [...inFlight.values()].reduce((sum, loaded) => sum + loaded, 0), source);
    const readWhole = async () => {
      complete.clear();
      report('downloading', 0, source);
      let previous = 0;
      const result = await readRequest({ ...options, source, signal: controller.signal, headers: {},
        inspect(response) {
          if (response.status !== 200) throw failure('DOWNLOAD_FAILED', '下载线路未返回完整文件');
          return size;
        },
        onChunk(loaded) {
          noteBytes(loaded - previous);
          previous = loaded;
          report('downloading', loaded, source);
        }
      });
      return { bytes: result.bytes, contributors: new Set([source.url]) };
    };
    const readPart = async (index, allowWhole) => {
      const start = index * segmentBytes;
      const end = Math.min(size, start + segmentBytes) - 1;
      let whole = false;
      let previous = 0;
      const result = await readRequest({ ...options, source, signal: controller.signal,
        headers: { Range: `bytes=${start}-${end}` },
        inspect(response) {
          if (response.status === 200 && allowWhole) {
            whole = true;
            source.rangeSupported = false;
            complete.clear();
            return size;
          }
          if (response.status === 200) throw failure('RANGE_UNSUPPORTED', '该线路不支持分段下载');
          if (response.status !== 206) throw failure('DOWNLOAD_FAILED', '下载线路暂时不可用');
          assertRange(response, start, end, size);
          source.rangeSupported = true;
          return end - start + 1;
        },
        onChunk(loaded) {
          noteBytes(loaded - previous);
          previous = loaded;
          if (whole) report('downloading', loaded, source);
          else { inFlight.set(index, loaded); progress(); }
        }
      });
      inFlight.delete(index);
      checkCancelled(controller.signal);
      if (whole) return { bytes: result.bytes, contributors: new Set([source.url]) };
      complete.set(index, { bytes: result.bytes, source: source.url });
      progress();
      return null;
    };
    try {
      if (source.rangeSupported === false) return await readWhole();
      const missing = [];
      for (let index = 0; index < count; index++) if (!complete.has(index)) missing.push(index);
      if (missing.length && source.rangeSupported !== true) {
        // Detect ignored Range before opening multiple redundant full downloads.
        const whole = await readPart(missing.shift(), true);
        if (whole) return whole;
      }
      let next = 0;
      let firstError;
      await Promise.allSettled(Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
        while (next < missing.length && !controller.signal.aborted) {
          const index = missing[next++];
          try { await readPart(index, false); }
          catch (error) {
            firstError ||= error;
            controller.abort(error);
            throw error;
          }
        }
      }));
      if (firstError) throw firstError;
      checkCancelled(controller.signal);
      const parts = Array.from({ length: count }, (_, index) => complete.get(index));
      if (parts.some(part => !part) || completeBytes() !== size) {
        throw failure('SIZE_MISMATCH', '下载文件不完整');
      }
      return { bytes: joinBytes(parts.map(part => part.bytes), size),
        contributors: new Set(parts.map(part => part.source)) };
    } finally {
      clearInterval(speedTimer);
      controller.abort();
      unlink();
      inFlight.clear();
    }
  }

  for (let index = 0; index < candidates.length; index++) {
    checkCancelled(signal);
    const source = candidates[index];
    report(index ? 'switching' : 'downloading', completeBytes(), source);
    let result;
    try {
      const alternativeSpeed = Math.max(0, ...candidates.slice(index + 1)
        .filter(candidate => candidate.url !== source.url).map(candidate => candidate.probeSpeed || 0));
      result = await fromSource(source, alternativeSpeed);
      report('verifying', size, source);
      const pendingDigest = digestImpl ? digestImpl(result.bytes)
        : cryptoImpl.subtle.digest('SHA-256', result.bytes);
      const digest = await interruptible(pendingDigest, signal || new AbortController().signal);
      const actual = typeof digest === 'string' ? digest.replace(/^sha256:/i, '').toLowerCase()
        : Array.from(new Uint8Array(digest.buffer ?? digest, digest.byteOffset ?? 0,
          digest.byteLength), byte => byte.toString(16).padStart(2, '0')).join('');
      checkCancelled(signal);
      if (actual !== asset.digest.slice(7).toLowerCase()) {
        throw failure('CHECKSUM_MISMATCH', '下载文件校验失败，已停止保存并尝试其他线路');
      }
      if (result.bytes.byteLength !== size) throw failure('SIZE_MISMATCH', '下载文件大小不正确');
      return { blob: new Blob([result.bytes], { type: 'application/octet-stream' }),
        filename: asset.name, source: source.label };
    } catch (error) {
      checkCancelled(signal);
      lastError = error;
      if (error.code === 'CHECKSUM_MISMATCH') {
        complete.clear();
        // A healthy fallback must get a clean attempt after reusing bytes from
        // another source. Otherwise one poisoned complete part survives forever.
        if (result?.contributors.size > 1 && !cleanRetries.has(source.url)) {
          cleanRetries.add(source.url);
          candidates.splice(index + 1, 0, source);
        }
      } else if (error.code === 'RANGE_UNSUPPORTED' && source.rangeSupported !== false) {
        complete.clear();
        source.rangeSupported = false;
        candidates.splice(index + 1, 0, source);
      }
    }
  }
  complete.clear();
  throw lastError || failure('DOWNLOAD_FAILED', '所有下载线路均暂时不可用，请稍后重试');
}
