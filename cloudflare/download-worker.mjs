// Module Worker: native streaming + bounded edge caching; no object-storage binding.
// Set DOWNLOAD_AUTH_SECRET to the same secret used by the website authorization API.
/**
 * @typedef {{
 *   match(request: Request): Promise<Response | undefined>,
 *   put(request: Request, response: Response): Promise<void>
 * }} DownloadCache
 * @typedef {typeof globalThis & {
 *   caches?: { default?: DownloadCache }
 * }} WorkerRuntime
 */
const runtime = /** @type {WorkerRuntime} */ (globalThis);

const BLOB_ORIGIN = 'https://4rgpxcwwpeiy2uij.public.blob.vercel-storage.com';
const GITHUB_RELEASES = 'https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download';
const SEGMENT_BYTES = 1024 * 1024;
const CACHE_SECONDS = 31536000;
const AUTH_TTL_SECONDS = 3600;
const ASSETS = new Set([
  'The-Melody-of-Oblivion-Remake-Windows-x64.exe',
  'The-Melody-of-Oblivion-Remake-Windows-ia32.exe',
  'The-Melody-of-Oblivion-Remake-Windows-arm64.exe',
  'The-Melody-of-Oblivion-Remake-Linux-x64.AppImage',
  'The-Melody-of-Oblivion-Remake-Linux-arm64.AppImage',
  'The-Melody-of-Oblivion-Remake-Linux-armv7l.AppImage',
  'The-Melody-of-Oblivion-Remake-macOS-x64.zip',
  'The-Melody-of-Oblivion-Remake-macOS-arm64.zip'
]);
const COPIED_HEADERS = ['content-type', 'content-length', 'content-range', 'etag', 'last-modified'];
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Disposition, Accept-Ranges, ETag, Last-Modified, X-Melody-Cache',
  'Access-Control-Max-Age': '86400'
};

function route(url) {
  // Exact paths and filenames prevent this Worker becoming a general-purpose proxy.
  if (url.hash || [...url.searchParams.keys()].some(key => !['expires', 'signature'].includes(key))) return null;
  const match = /^\/releases\/(v\d+\.\d+\.\d+)\/([^/]+)$/.exec(url.pathname);
  if (!match || !ASSETS.has(match[2])) return null;
  const [, tag, filename] = match;
  const path = `${tag}/${filename}`;
  const github = `${GITHUB_RELEASES}/${path}`;
  return { tag, filename, path, origins: filename.includes('-Windows-')
    ? [`${BLOB_ORIGIN}/releases/${path}`, github] : [github] };
}

function rangeOf(value) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error('Only a single byte range is supported');
  const start = match[1] ? Number(match[1]) : null;
  const end = match[2] ? Number(match[2]) : null;
  if ((start !== null && !Number.isSafeInteger(start))
    || (end !== null && !Number.isSafeInteger(end))
    || (start !== null && end !== null && start > end)
    || (start === null && end === 0)) throw new Error('Invalid byte range');
  return { value, start, end };
}

function lengthOf(headers) {
  const value = headers.get('content-length');
  if (value === null) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid upstream length');
  return Number(value);
}

function inspectRange(response, range) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
  if (!range || !match) throw new Error('Missing upstream range');
  const [start, end, size] = match.slice(1).map(Number);
  if (![start, end, size].every(Number.isSafeInteger) || start > end || end >= size) {
    throw new Error('Invalid upstream range');
  }
  const expectedStart = range.start === null ? Math.max(0, size - range.end) : range.start;
  const expectedEnd = range.start === null || range.end === null ? size - 1 : Math.min(range.end, size - 1);
  const length = end - start + 1;
  if (start !== expectedStart || end !== expectedEnd
    || (lengthOf(response.headers) !== null && lengthOf(response.headers) !== length)) {
    throw new Error('Upstream returned a different range');
  }
  return { start, end, size, length };
}

function headersFor(response, filename, cacheState) {
  const headers = new Headers(CORS_HEADERS);
  for (const name of COPIED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  headers.set('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
  // Cloudflare's compression layer can remove Content-Length, including on HEAD.
  // Preserve the installer's byte representation and metadata without a dummy body.
  // Only the internal Cache API entry is public. Browser/CDN caches must not
  // keep authorized responses beyond the signed URL's expiry.
  headers.set('Cache-Control', 'private, no-store, no-transform');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Melody-Cache', cacheState);
  return headers;
}

function errorResponse(status, message, method = 'GET', extraHeaders = {}) {
  return new Response(method === 'HEAD' ? null : message, {
    status, headers: { ...CORS_HEADERS, ...extraHeaders, 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }
  });
}

function cacheKey(url, asset, kind) {
  return new Request(`${url.origin}/.melody-cache/v2/${kind}/${asset.path}`);
}

async function cacheMatch(cache, key) {
  try { return cache ? await cache.match(key) : null; } catch { return null; }
}

function discard(response) {
  try { response.body?.cancel().catch(() => {}); } catch { /* Already consumed. */ }
}

function allowedRedirect(url, initialUrl) {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.href === initialUrl) return true;
  // These are GitHub's signed release-asset delivery hosts, never client input.
  return initialUrl.startsWith(`${GITHUB_RELEASES}/`)
    && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
    && url.pathname.startsWith('/github-production-release-asset');
}

async function originFetch(fetchImpl, initialUrl, options) {
  let url = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects++) {
    // Keep implicit subrequest caching separate from our explicit Cache API.
    // An origin may still ignore Range, in which case callers receive a full 200.
    const response = await fetchImpl(url, {
      ...options, redirect: 'manual', cache: 'no-store'
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    discard(response);
    const next = location ? new URL(location, url) : null;
    if (!next || !allowedRedirect(next, initialUrl)) throw new Error('Unapproved upstream redirect');
    url = next.href;
  }
  throw new Error('Too many upstream redirects');
}

// Native clone/tee is limited to at most one 1 MiB segment. Large full-file
// responses are passed straight through, so a slow cache cannot buffer an
// installer in Worker memory or execute a JavaScript callback for every chunk.
function cacheSmallResponse(response, storage, key, headers, context) {
  if (!context?.waitUntil) return;
  let stored;
  try {
    const internalHeaders = new Headers(headers);
    internalHeaders.set('Cache-Control', `public, max-age=${CACHE_SECONDS}, immutable, no-transform`);
    stored = new Response(response.clone().body, { headers: internalHeaders });
    context.waitUntil(Promise.resolve().then(() => storage.put(key, stored)).catch(() => discard(stored)));
  } catch { if (stored) discard(stored); }
}

function authorizationVerifier() {
  let previousSecret;
  let signingKey;
  return async function authorized(url, secret) {
    if (typeof secret !== 'string' || new TextEncoder().encode(secret).byteLength < 32 || secret.length > 4096) return null;
    const expires = url.searchParams.get('expires');
    const signature = url.searchParams.get('signature');
    if (url.searchParams.getAll('expires').length !== 1 || url.searchParams.getAll('signature').length !== 1
      || !/^\d{10,12}$/.test(expires ?? '') || !/^[A-Za-z\d_-]{43}$/.test(signature ?? '')) return false;
    const expiry = Number(expires);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + AUTH_TTL_SECONDS) return false;
    try {
      if (previousSecret !== secret) {
        previousSecret = secret;
        signingKey = crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
          { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      }
      const bytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/') + '='), character => character.charCodeAt(0));
      return await crypto.subtle.verify('HMAC', await signingKey, bytes,
        new TextEncoder().encode(`download-v1\n${url.pathname}\n${expires}`));
    } catch { return false; }
  };
}

/** @param {{ fetchImpl?: typeof fetch, cache?: DownloadCache | null }} [options] */
export function createDownloadWorker({ fetchImpl = (input, init) => fetch(input, init), cache } = {}) {
  const authorized = authorizationVerifier();
  return {
    async fetch(request, env, context) {
      const { method } = request;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        return errorResponse(405, 'Method not allowed', method, { Allow: 'GET, HEAD, OPTIONS' });
      }
      const url = new URL(request.url);
      const asset = route(url);
      if (!asset) return errorResponse(404, 'Unknown release asset', method);
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
      const access = await authorized(url, env?.DOWNLOAD_AUTH_SECRET);
      if (access === null) return errorResponse(503, 'Verified downloads are not configured', method);
      if (!access) return errorResponse(403, 'Verify you are human on the website before downloading', method);
      let range;
      try { range = method === 'HEAD' ? null : rangeOf(request.headers.get('range')); }
      catch { return errorResponse(416, 'Use one valid byte range', method); }
      const storage = cache === undefined ? runtime.caches?.default : cache;
      const fullKey = cacheKey(url, asset, 'full');
      const ifRange = range && request.headers.get('if-range');
      if (!ifRange) {
        const lookup = range ? new Request(fullKey, { headers: { Range: range.value } }) : fullKey;
        const hit = await cacheMatch(storage, lookup);
        if (hit && ((!range && hit.status === 200) || (range && hit.status === 206))) {
          try {
            if (range) inspectRange(hit, range);
            if (method === 'HEAD') discard(hit);
            return new Response(method === 'HEAD' ? null : hit.body, {
              status: hit.status, headers: headersFor(hit, asset.filename, 'HIT')
            });
          } catch { discard(hit); }
        } else if (hit) discard(hit);
      }
      const segmentCandidate = range && !ifRange && range.start !== null && range.end !== null
        && range.start % SEGMENT_BYTES === 0 && range.end - range.start < SEGMENT_BYTES;
      const segmentKey = segmentCandidate ? cacheKey(url, asset, `range/${range.start}-${range.end}`) : null;
      if (segmentKey) {
        const hit = await cacheMatch(storage, segmentKey);
        if (hit) {
          const headers = new Headers(hit.headers);
          headers.set('Content-Range', headers.get('X-Melody-Content-Range') || '');
          const restored = new Response(hit.body, { status: 206, headers });
          try {
            inspectRange(restored, range);
            return new Response(restored.body, { status: 206, headers: headersFor(restored, asset.filename, 'HIT') });
          } catch { discard(restored); }
        }
      }
      const upstreamHeaders = new Headers({ 'Accept-Encoding': 'identity' });
      if (range) upstreamHeaders.set('Range', range.value);
      if (ifRange) upstreamHeaders.set('If-Range', ifRange);
      let allMissing = true;
      for (const origin of asset.origins) {
        let upstream;
        try {
          upstream = await originFetch(fetchImpl, origin, { method, headers: upstreamHeaders });
          if (upstream.status === 416) {
            discard(upstream);
            return new Response(null, { status: 416, headers: headersFor(upstream, asset.filename, 'BYPASS') });
          }
          if (upstream.status !== 404) allMissing = false;
          if (![200, 206].includes(upstream.status)) { discard(upstream); continue; }
          if (/text\/html|application\/json/i.test(upstream.headers.get('content-type') || '')
            || (upstream.headers.get('content-encoding') && upstream.headers.get('content-encoding') !== 'identity')) {
            throw new Error('Unexpected upstream representation');
          }
          const part = upstream.status === 206 ? inspectRange(upstream, range) : null;
          const length = part?.length ?? lengthOf(upstream.headers);
          const headers = headersFor(upstream, asset.filename, 'MISS');
          if (part) headers.set('Content-Length', String(part.length));
          if (method === 'HEAD') {
            discard(upstream);
            return new Response(null, { status: upstream.status, headers });
          }
          if (!upstream.body) throw new Error('Missing upstream body');
          const canStoreSegment = segmentKey && part && part.start % SEGMENT_BYTES === 0
            && (part.length === SEGMENT_BYTES || part.end === part.size - 1);
          const targetKey = !ifRange && upstream.status === 200 ? fullKey : canStoreSegment ? segmentKey : null;
          let body = upstream.body;
          if (storage && targetKey && length !== null && length > 0 && length <= SEGMENT_BYTES) {
            const storedHeaders = new Headers(headers);
            if (part) {
              storedHeaders.set('X-Melody-Content-Range', headers.get('Content-Range'));
              storedHeaders.delete('Content-Range');
            }
            cacheSmallResponse(upstream, storage, targetKey, storedHeaders, context);
            body = upstream.body;
          }
          // Retain the fetch body's native length and backpressure. No manual
          // reader, FixedLengthStream, Promise.race, or per-chunk timers.
          return new Response(body, { status: upstream.status, headers });
        } catch {
          allMissing = false;
          if (upstream) discard(upstream);
        }
      }
      return errorResponse(allMissing ? 404 : 502,
        allMissing ? 'Release asset not found' : 'Download origin unavailable', method);
    }
  };
}

export default createDownloadWorker();
