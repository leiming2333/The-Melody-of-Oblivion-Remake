const USER_AGENT = 'melody-of-oblivion-launcher-updater';
const SAMPLE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 3000;
const MIN_SPEED_BYTES_PER_SECOND = 100 * 1024;

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error('启动器更新已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
  }
}

async function probeDownloadSource(url, {
  signal, expectedSize, fetchImpl = globalThis.fetch,
  sampleBytes = SAMPLE_BYTES, timeoutMs = PROBE_TIMEOUT_MS
} = {}) {
  throwIfAborted(signal);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const startedAt = performance.now();
  let bytes = 0;
  let firstByteMs = null;
  let reader;
  const end = Math.min(sampleBytes, expectedSize || sampleBytes) - 1;
  try {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, Range: `bytes=0-${end}`, 'Accept-Encoding': 'identity' },
      signal: controller.signal
    });
    if (!response.body) return null;
    reader = response.body.getReader();
    if (response.status === 206) {
      const range = /^bytes 0-(\d+)\/(\d+)$/i.exec(response.headers.get('content-range') || '');
      if (!range || Number(range[1]) !== end
        || (expectedSize && Number(range[2]) !== expectedSize)) return null;
    } else if (response.status === 200) {
      const length = Number(response.headers.get('content-length'));
      if ((expectedSize && length && length !== expectedSize)
        || /(?:text\/html|application\/json)/i.test(response.headers.get('content-type') || '')) return null;
    } else return null;

    while (bytes <= end) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length && firstByteMs === null) firstByteMs = performance.now() - startedAt;
      bytes += Math.min(value.length, end + 1 - bytes);
    }
  } catch {
    // A bounded probe may time out after receiving useful throughput samples.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    await reader?.cancel().catch(() => {});
  }
  throwIfAborted(signal);
  if (!bytes) return null;
  return { bytesPerSecond: bytes * 1000 / Math.max(1, performance.now() - startedAt), firstByteMs };
}

async function rankDownloadCandidates(candidates, options = {}) {
  throwIfAborted(options.signal);
  const strict = candidates.filter((candidate) => candidate.enforceMinSpeed !== false);
  const unique = [...new Map(strict.map((candidate) => [candidate.url, candidate])).values()];
  if (unique.length < 2) return candidates;
  const probes = await Promise.allSettled(unique.map(async (candidate) => ({
    candidate, sample: await probeDownloadSource(candidate.url, options)
  })));
  throwIfAborted(options.signal);
  const measured = probes.flatMap((result) => result.status === 'fulfilled' && result.value.sample
    ? [result.value] : []);
  if (!measured.length) return candidates;
  measured.sort((a, b) => b.sample.bytesPerSecond - a.sample.bytesPerSecond);
  const ranked = measured.map(({ candidate, sample }) => ({
    ...candidate,
    // Keep a usable slow route when every available route is below 100 KiB/s.
    minSpeedBytesPerSecond: Math.min(MIN_SPEED_BYTES_PER_SECOND, sample.bytesPerSecond / 2)
  }));
  const measuredUrls = new Set(measured.map(({ candidate }) => candidate.url));
  const unmeasured = strict.filter((candidate) => !measuredUrls.has(candidate.url));
  const fallback = candidates.filter((candidate) => candidate.enforceMinSpeed === false);
  if (!fallback.some((candidate) => candidate.url === ranked[0].url)) {
    fallback.unshift({ ...ranked[0], enforceMinSpeed: false });
  }
  return [...ranked, ...unmeasured, ...fallback];
}

module.exports = { probeDownloadSource, rankDownloadCandidates };
