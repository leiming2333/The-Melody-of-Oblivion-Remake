const BMCLAPI_BASE = 'https://bmclapi2.bangbang93.com';
const OFFICIAL_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const BMCLAPI_MANIFEST = `${BMCLAPI_BASE}/mc/game/version_manifest_v2.json`;
const OFFICIAL_ASSETS = 'https://resources.download.minecraft.net';
const LSS233_LIBRARY_BASE = 'https://lss233.littleservice.cn/repositories/minecraft';

const SOURCES = Object.freeze({
  bmclapi: Object.freeze({
    id: 'bmclapi',
    label: 'BMCLAPI',
    manifestUrl: BMCLAPI_MANIFEST
  }),
  official: Object.freeze({
    id: 'official',
    label: 'Mojang 官方',
    manifestUrl: OFFICIAL_MANIFEST
  })
});

const DEFAULT_HEADERS = Object.freeze({
  Accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
  'User-Agent': 'MelodyOfOblivionLauncher/0.1.0'
});

const DOWNLOAD_SOURCE_OPTIONS = Object.freeze(['auto', 'bmclapi', 'official']);
const BENCHMARK_SAMPLE_BYTES = 128 * 1024;
const BENCHMARK_CONCURRENCY = 3;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timer };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const { controller, timer } = createTimeoutSignal(timeoutMs);
  const signals = [controller.signal, options.signal].filter(Boolean);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  try {
    return await fetch(url, {
      redirect: 'follow',
      ...options,
      headers: {
        ...DEFAULT_HEADERS,
        ...options.headers
      },
      signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);

  if (!response.ok) {
    throw new Error(`请求失败：HTTP ${response.status} ${url}`);
  }

  return response.json();
}

function officialAssetUrl(hash) {
  return `${OFFICIAL_ASSETS}/${hash.slice(0, 2)}/${hash}`;
}

function mirrorUrl(type, context) {
  switch (type) {
    case 'manifest':
      return BMCLAPI_MANIFEST;
    case 'version-json':
      return `${BMCLAPI_BASE}/version/${encodeURIComponent(context.versionId)}/json`;
    case 'client':
      return `${BMCLAPI_BASE}/version/${encodeURIComponent(context.versionId)}/client`;
    case 'asset':
      return `${BMCLAPI_BASE}/assets/${context.hash.slice(0, 2)}/${context.hash}`;
    case 'library':
      return `${BMCLAPI_BASE}/maven/${context.path.replace(/^\/+/, '')}`;
    case 'asset-index':
    case 'logging': {
      if (!context.originalUrl) {
        return undefined;
      }
      const parsed = new URL(context.originalUrl);
      return `${BMCLAPI_BASE}${parsed.pathname}${parsed.search}`;
    }
    default:
      return context.originalUrl;
  }
}

function officialUrl(type, context) {
  switch (type) {
    case 'manifest':
      return OFFICIAL_MANIFEST;
    case 'asset':
      return officialAssetUrl(context.hash);
    default:
      return context.originalUrl;
  }
}

function resolveSourceUrl(sourceId, type, context) {
  return sourceId === 'bmclapi' ? mirrorUrl(type, context) : officialUrl(type, context);
}

class MinecraftSourceManager {
  constructor({
    probeTimeoutMs = 6500,
    cacheDurationMs = 5 * 60 * 1000,
    benchmarkTimeoutMs = 6000,
    benchmarkCacheDurationMs = 2 * 60 * 1000
  } = {}) {
    this.probeTimeoutMs = probeTimeoutMs;
    this.cacheDurationMs = cacheDurationMs;
    this.benchmarkTimeoutMs = benchmarkTimeoutMs;
    this.benchmarkCacheDurationMs = benchmarkCacheDurationMs;
    this.downloadPreference = 'auto';
    this.selectionCache = undefined;
    this.downloadSelectionCache = undefined;
    this.manifestCache = undefined;
  }

  setDownloadPreference(preference) {
    const normalized = DOWNLOAD_SOURCE_OPTIONS.includes(preference) ? preference : 'auto';
    if (normalized !== this.downloadPreference) {
      this.downloadPreference = normalized;
      this.selectionCache = undefined;
      this.downloadSelectionCache = undefined;
      this.manifestCache = undefined;
    }
    return normalized;
  }

  async probe(source) {
    const startedAt = Date.now();
    const response = await fetchWithTimeout(
      source.manifestUrl,
      { method: 'HEAD', headers: { Accept: 'application/json' } },
      this.probeTimeoutMs
    );

    if (!response.ok) {
      throw new Error(`${source.label}不可用：HTTP ${response.status}`);
    }

    return {
      ...source,
      latency: Date.now() - startedAt,
      checkedAt: Date.now()
    };
  }

  async selectSource({ force = false } = {}) {
    if (this.downloadPreference !== 'auto') {
      return { ...SOURCES[this.downloadPreference], checkedAt: Date.now() };
    }

    if (
      !force &&
      this.selectionCache &&
      Date.now() - this.selectionCache.checkedAt < this.cacheDurationMs
    ) {
      return this.selectionCache;
    }

    const probes = Object.values(SOURCES).map((source) => this.probe(source));

    try {
      this.selectionCache = await Promise.any(probes);
      return this.selectionCache;
    } catch {
      throw new Error('BMCLAPI 与 Mojang 官方源均无法连接，请检查网络后重试');
    }
  }

  sourceOrder(preferredSourceId) {
    const configured = this.downloadPreference === 'auto' ? undefined : this.downloadPreference;
    const preferred = SOURCES[preferredSourceId]
      ? preferredSourceId
      : configured ?? 'official';
    return preferred === 'bmclapi' ? ['bmclapi', 'official'] : ['official', 'bmclapi'];
  }

  async benchmarkUrl(
    url,
    { signal, sampleBytes = BENCHMARK_SAMPLE_BYTES, rangeStart = 0 } = {}
  ) {
    const controller = new AbortController();
    const signals = [controller.signal, signal].filter(Boolean);
    const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const timer = setTimeout(() => controller.abort(), this.benchmarkTimeoutMs);
    const startedAt = performance.now();
    let reader;
    let receivedBytes = 0;

    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Range: `bytes=${rangeStart}-${Math.max(rangeStart, rangeStart + sampleBytes - 1)}`,
          'Accept-Encoding': 'identity'
        },
        signal: combinedSignal
      }, this.benchmarkTimeoutMs);
      if (!response.ok || !response.body) {
        throw new Error(`测速失败：HTTP ${response.status}`);
      }

      reader = response.body.getReader();
      while (receivedBytes < sampleBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedBytes += Math.min(value.byteLength, sampleBytes - receivedBytes);
      }

      if (receivedBytes <= 0) throw new Error('测速未收到数据');
      const elapsedMs = Math.max(1, performance.now() - startedAt);
      return {
        url,
        bytes: receivedBytes,
        elapsedMs,
        bytesPerSecond: Math.round((receivedBytes * 1000) / elapsedMs)
      };
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
    }
  }

  async benchmarkSource(url, { signal } = {}) {
    const startedAt = performance.now();
    const results = await Promise.allSettled(Array.from(
      { length: BENCHMARK_CONCURRENCY },
      (_value, index) => this.benchmarkUrl(url, {
        signal,
        sampleBytes: BENCHMARK_SAMPLE_BYTES,
        rangeStart: index * BENCHMARK_SAMPLE_BYTES
      })
    ));
    if (signal?.aborted) {
      const error = new Error('下载已取消');
      error.name = 'AbortError';
      throw error;
    }

    const successful = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    if (successful.length === 0) throw new Error('下载源测速失败');

    const bytes = successful.reduce((sum, result) => sum + result.bytes, 0);
    const elapsedMs = Math.max(1, performance.now() - startedAt);
    return {
      url,
      bytes,
      elapsedMs,
      connections: successful.length,
      bytesPerSecond: Math.round((bytes * 1000) / elapsedMs)
    };
  }

  async selectDownloadSource({ versionId, originalUrl, force = false, signal } = {}) {
    if (this.downloadPreference !== 'auto') {
      return {
        ...SOURCES[this.downloadPreference],
        preference: this.downloadPreference,
        checkedAt: Date.now()
      };
    }

    if (
      !force &&
      this.downloadSelectionCache &&
      Date.now() - this.downloadSelectionCache.checkedAt < this.benchmarkCacheDurationMs
    ) {
      return this.downloadSelectionCache;
    }

    if (signal?.aborted) {
      const error = new Error('下载已取消');
      error.name = 'AbortError';
      throw error;
    }

    const candidates = Object.values(SOURCES).map((source) => ({
      source,
      url: resolveSourceUrl(source.id, 'client', { versionId, originalUrl })
    })).filter((candidate) => candidate.url);
    const settled = await Promise.allSettled(candidates.map(async (candidate) => ({
      ...candidate,
      benchmark: await this.benchmarkSource(candidate.url, { signal })
    })));
    if (signal?.aborted) {
      const error = new Error('下载已取消');
      error.name = 'AbortError';
      throw error;
    }

    const successful = settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value)
      .sort((left, right) => right.benchmark.bytesPerSecond - left.benchmark.bytesPerSecond);

    if (successful.length === 0) {
      const fallback = await this.selectSource({ force });
      this.downloadSelectionCache = {
        ...fallback,
        preference: 'auto',
        benchmarkFailed: true,
        checkedAt: Date.now()
      };
      return this.downloadSelectionCache;
    }

    const fastest = successful[0];
    this.downloadSelectionCache = {
      ...fastest.source,
      preference: 'auto',
      throughput: fastest.benchmark.bytesPerSecond,
      speeds: Object.fromEntries(successful.map((candidate) => [
        candidate.source.id,
        candidate.benchmark.bytesPerSecond
      ])),
      checkedAt: Date.now()
    };
    return this.downloadSelectionCache;
  }

  getCandidateUrls(type, context, preferredSourceId) {
    const standardUrls = unique(
      this.sourceOrder(preferredSourceId).map((sourceId) =>
        resolveSourceUrl(sourceId, type, context)
      )
    );
    if (type !== 'library' || !context.path) return standardUrls;

    const lss233Url = `${LSS233_LIBRARY_BASE}/${context.path.replace(/^\/+/, '')}`;
    const libraryUrls = this.downloadPreference === 'auto'
      ? this.sourceOrder('bmclapi').map((sourceId) => resolveSourceUrl(sourceId, type, context))
      : standardUrls;
    return unique([...libraryUrls, lss233Url]);
  }

  async fetchJsonFromSources(type, context, preferredSourceId) {
    const sourceOrder = this.sourceOrder(preferredSourceId);
    const errors = [];

    for (const sourceId of sourceOrder) {
      const url = resolveSourceUrl(sourceId, type, context);
      if (!url) {
        continue;
      }

      try {
        return {
          data: await fetchJson(url),
          source: SOURCES[sourceId],
          url
        };
      } catch (error) {
        errors.push(error);
      }
    }

    throw errors.at(-1) ?? new Error('没有可用的下载地址');
  }

  async getVersionManifest({ force = false } = {}) {
    if (
      !force &&
      this.manifestCache &&
      Date.now() - this.manifestCache.fetchedAt < this.cacheDurationMs
    ) {
      return this.manifestCache;
    }

    let result;
    let latency;
    if (this.downloadPreference === 'auto') {
      const startedAt = Date.now();
      try {
        result = await Promise.any(Object.values(SOURCES).map(async (source) => ({
          data: await fetchJson(source.manifestUrl),
          source,
          url: source.manifestUrl
        })));
      } catch {
        throw new Error('BMCLAPI 与 Mojang 官方源均无法连接，请检查网络后重试');
      }
      latency = Date.now() - startedAt;
      this.selectionCache = {
        ...result.source,
        latency,
        checkedAt: Date.now()
      };
    } else {
      const selected = await this.selectSource({ force });
      const startedAt = Date.now();
      result = await this.fetchJsonFromSources('manifest', {}, selected.id);
      latency = Date.now() - startedAt;
    }
    this.manifestCache = {
      manifest: result.data,
      source: {
        ...result.source,
        latency
      },
      fetchedAt: Date.now()
    };
    return this.manifestCache;
  }
}

module.exports = {
  BENCHMARK_SAMPLE_BYTES,
  BMCLAPI_BASE,
  DOWNLOAD_SOURCE_OPTIONS,
  LSS233_LIBRARY_BASE,
  OFFICIAL_MANIFEST,
  SOURCES,
  MinecraftSourceManager,
  fetchWithTimeout,
  officialAssetUrl,
  resolveSourceUrl
};
