const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');

const filename = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';
const unsignedUrl = `https://downloads.melodyoblivion.xyz/releases/v1.9.1/${filename}`;
const secret = 'unit-test-worker-authorization-secret-at-least-32';
function signedUrl(value = unsignedUrl, expires = Math.floor(Date.now() / 1000) + 900) {
  const url = new URL(value);
  const signature = createHmac('sha256', secret).update(`download-v1\n${url.pathname}\n${expires}`).digest('base64url');
  url.searchParams.set('expires', expires);
  url.searchParams.set('signature', signature);
  return url.href;
}
const publicUrl = signedUrl();
const blobUrl = `https://4rgpxcwwpeiy2uij.public.blob.vercel-storage.com/releases/v1.9.1/${filename}`;
const githubUrl = `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/v1.9.1/${filename}`;
const segmentBytes = 1024 * 1024;
const realWorkerModule = import('../cloudflare/download-worker.mjs');
// All existing delivery scenarios now use a real signed URL and configured
// secret. Authorization failure scenarios below call the unwrapped Worker.
const workerModule = realWorkerModule.then(module => ({ ...module,
  createDownloadWorker(options) {
    const worker = module.createDownloadWorker(options);
    return { fetch(request, env = {}, context) {
      return worker.fetch(request, { DOWNLOAD_AUTH_SECRET: secret, ...env }, context);
    } };
  }
}));

function execution() {
  const pending = [];
  return { waitUntil(promise) { pending.push(promise); }, async finish() { await Promise.all(pending); } };
}

function memoryCache() {
  const entries = new Map();
  const puts = [];
  return {
    entries, puts,
    async put(key, response) {
      // Cloudflare refuses a 206 cache.put; the test deliberately does too.
      assert.equal(response.status, 200);
      assert.equal(response.headers.has('content-range'), false);
      const entry = { bytes: new Uint8Array(await response.arrayBuffer()), headers: new Headers(response.headers) };
      entries.set(key.url, entry);
      puts.push({ url: key.url, length: entry.bytes.length, headers: entry.headers });
    },
    async match(key) {
      const entry = entries.get(key.url);
      if (!entry) return undefined;
      // Cache API can synthesize a Range from a stored full response with Content-Length.
      const range = key.headers.get('range');
      if (range) {
        assert.equal(range, 'bytes=2-5');
        const headers = new Headers(entry.headers);
        headers.set('Content-Range', `bytes 2-5/${entry.bytes.length}`);
        headers.set('Content-Length', '4');
        return new Response(entry.bytes.slice(2, 6), { status: 206, headers });
      }
      return new Response(entry.bytes.slice(), { headers: entry.headers });
    }
  };
}

function assetResponse(bytes, { start = 0, end = bytes.length - 1, partial = false } = {}) {
  return new Response(bytes.slice(start, end + 1), {
    status: partial ? 206 : 200,
    headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start + 1),
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {})
    }
  });
}

test('only fixed versioned release paths and methods can reach an origin', async () => {
  const { createDownloadWorker } = await workerModule;
  let calls = 0;
  const worker = createDownloadWorker({ cache: null, fetchImpl() { calls++; throw new Error('must not fetch'); } });
  for (const path of [
    '/?url=https://example.com', '/releases/latest.json', `/releases/latest/${filename}`,
    `/releases/v1.9.1/${filename}?url=https://example.com`, '/releases/v1.9.1/arbitrary.exe',
    `/releases/v1.9.1/${filename}/extra`, `/releases/v1.9.1/%2e%2e%2f${filename}`
  ]) {
    assert.equal((await worker.fetch(new Request(`https://downloads.melodyoblivion.xyz${path}`))).status, 404);
  }
  assert.equal((await worker.fetch(new Request(publicUrl, { method: 'POST', body: 'x' }))).status, 405);
  assert.equal(calls, 0);
  const preflight = await worker.fetch(new Request(publicUrl, { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Range/);
});

test('HEAD forwards no body or Range, with CORS and the original full length', async () => {
  const { createDownloadWorker } = await workerModule;
  const worker = createDownloadWorker({ cache: null, fetchImpl: async (url, options) => {
    assert.equal(url, blobUrl);
    assert.equal(options.method, 'HEAD');
    assert.equal(options.headers.get('range'), null);
    assert.equal(options.headers.get('cookie'), null);
    assert.equal(options.headers.get('authorization'), null);
    return new Response(null, { headers: { 'Content-Length': '103871652' } });
  } });
  const result = await worker.fetch(new Request(publicUrl, { method: 'HEAD', headers: { Range: 'bytes=0-100' } }));
  assert.equal(result.status, 200);
  assert.equal(result.body, null);
  assert.equal(result.headers.get('content-length'), '103871652');
  assert.equal(result.headers.get('access-control-allow-origin'), '*');
  assert.match(result.headers.get('cache-control'), /(?:^|,\s*)no-transform(?:,|$)/);
});

test('HEAD cache hits preserve full length without reading bytes or creating a pending fixed-length body', async () => {
  const { createDownloadWorker } = await workerModule;
  const original = globalThis.FixedLengthStream;
  let read = false;
  let cancelled = false;
  globalThis.FixedLengthStream = class {
    constructor() { assert.fail('HEAD must not create an unwritten fixed-length stream'); }
  };
  try {
    const context = { waitUntil() { assert.fail('HEAD must not schedule body or cache work'); } };
    const worker = createDownloadWorker({
      cache: {
        async match() {
          return new Response(new ReadableStream({
            pull() { read = true; assert.fail('HEAD must not read a cached installer'); },
            cancel() { cancelled = true; }
          }, { highWaterMark: 0 }), { headers: { 'Content-Length': '103871652' } });
        },
        async put() { assert.fail('HEAD must not write cache'); }
      },
      fetchImpl() { assert.fail('cached HEAD must not fetch the origin'); }
    });
    const result = await worker.fetch(new Request(publicUrl, { method: 'HEAD' }), {}, context);
    assert.equal(result.status, 200);
    assert.equal(result.body, null);
    assert.equal(result.headers.get('content-length'), '103871652');
    assert.match(result.headers.get('cache-control'), /(?:^|,\s*)no-transform(?:,|$)/);
    assert.equal(result.headers.get('x-melody-cache'), 'HIT');
    assert.equal(read, false);
    assert.equal(cancelled, true);
  } finally {
    if (original === undefined) delete globalThis.FixedLengthStream;
    else globalThis.FixedLengthStream = original;
  }
});

test('a full object streams into cache and later HEAD and Range need no origin', async () => {
  const { createDownloadWorker } = await workerModule;
  const cache = memoryCache();
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  let calls = 0;
  const worker = createDownloadWorker({ cache, fetchImpl: async () => { calls++; return assetResponse(bytes); } });
  const context = execution();
  const first = await worker.fetch(new Request(publicUrl), {}, context);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), bytes);
  await context.finish();
  assert.equal(cache.puts.length, 1);
  assert.match(cache.puts[0].url, /\/full\/v1\.9\.1\//);
  const head = await worker.fetch(new Request(publicUrl, { method: 'HEAD' }));
  assert.equal(head.headers.get('x-melody-cache'), 'HIT');
  assert.equal(head.body, null);
  const range = await worker.fetch(new Request(publicUrl, { headers: { Range: 'bytes=2-5' } }));
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/8');
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.slice(2, 6));
  assert.equal(calls, 1);
});

test('canonical 1 MiB ranges and final segments cache as internal 200 and restore correct 206', async () => {
  const { createDownloadWorker } = await workerModule;
  const bytes = new Uint8Array(segmentBytes + 17).fill(41);
  const cache = memoryCache();
  let calls = 0;
  const worker = createDownloadWorker({ cache, fetchImpl: async (_url, options) => {
    calls++;
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.get('range')).map(Number);
    return assetResponse(bytes, { start, end, partial: true });
  } });
  for (const [start, end] of [[0, segmentBytes - 1], [segmentBytes, bytes.length - 1]]) {
    const options = { headers: { Range: `bytes=${start}-${end}` } };
    const context = execution();
    const first = await worker.fetch(new Request(publicUrl, options), {}, context);
    assert.equal(first.status, 206);
    assert.equal((await first.arrayBuffer()).byteLength, end - start + 1);
    await context.finish();
    const hit = await worker.fetch(new Request(publicUrl, options));
    assert.equal(hit.status, 206);
    assert.equal(hit.headers.get('x-melody-cache'), 'HIT');
    assert.equal(hit.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal((await hit.arrayBuffer()).byteLength, end - start + 1);
  }
  assert.equal(calls, 2);
  assert.deepEqual(cache.puts.map(put => put.length), [segmentBytes, 17]);
});

test('probes, suffix/open ranges and If-Range work without fragmenting the segment cache', async () => {
  const { createDownloadWorker } = await workerModule;
  const bytes = new Uint8Array(segmentBytes * 2).fill(7);
  const cache = memoryCache();
  const worker = createDownloadWorker({ cache, fetchImpl: async (_url, options) => {
    const value = options.headers.get('range');
    if (value === 'bytes=0-32767') return assetResponse(bytes, { start: 0, end: 32767, partial: true });
    if (value === 'bytes=-8') return assetResponse(bytes, { start: bytes.length - 8, partial: true });
    if (value === `bytes=${bytes.length - 8}-`) return assetResponse(bytes, { start: bytes.length - 8, partial: true });
    assert.equal(options.headers.get('if-range'), '"version"');
    return assetResponse(bytes);
  } });
  for (const range of ['bytes=0-32767', 'bytes=-8', `bytes=${bytes.length - 8}-`]) {
    const result = await worker.fetch(new Request(publicUrl, { headers: { Range: range } }));
    assert.equal(result.status, 206);
    assert.ok((await result.arrayBuffer()).byteLength > 0);
  }
  const result = await worker.fetch(new Request(publicUrl, { headers: { Range: 'bytes=0-1', 'If-Range': '"version"' } }));
  assert.equal(result.status, 200);
  await result.arrayBuffer();
  assert.equal(cache.puts.length, 0);
});

test('Blob failures fall back to a signed GitHub asset stream, never a client redirect', async () => {
  const { createDownloadWorker } = await workerModule;
  const signedUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/abc?signature=signed';
  const calls = [];
  const worker = createDownloadWorker({ cache: null, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    if (url === blobUrl) return new Response('unavailable', { status: 503 });
    if (url === githubUrl) return new Response(null, { status: 302, headers: { Location: signedUrl } });
    assert.equal(url, signedUrl);
    return assetResponse(new Uint8Array([1, 2, 3]));
  } });
  const result = await worker.fetch(new Request(publicUrl));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('location'), null);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(calls, [blobUrl, githubUrl, signedUrl]);
});

test('unapproved redirects, HTML, mismatched ranges, errors and missing assets never enter cache', async () => {
  const { createDownloadWorker } = await workerModule;
  for (const responseFor of [
    () => new Response(null, { status: 302, headers: { Location: 'https://attacker.example/package.exe' } }),
    () => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('abcd', { status: 206, headers: { 'Content-Range': 'bytes 1-4/20', 'Content-Length': '4' } }),
    () => new Response('error', { status: 500 }),
    () => new Response('missing', { status: 404 })
  ]) {
    const cache = memoryCache();
    const worker = createDownloadWorker({ cache, fetchImpl: async url => {
      assert.ok([blobUrl, githubUrl].includes(url));
      return responseFor();
    } });
    const result = await worker.fetch(new Request(publicUrl, { headers: { Range: 'bytes=0-3' } }));
    assert.ok([404, 502].includes(result.status));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), '*');
    assert.equal(cache.puts.length, 0);
  }
});

test('invalid or multiple ranges never reach an origin', async () => {
  const { createDownloadWorker } = await workerModule;
  const worker = createDownloadWorker({ cache: null, fetchImpl() { assert.fail('must not fetch'); } });
  for (const Range of ['bytes=0-1,3-4', 'bytes=2-1', 'bytes=-0', 'bytes=-', 'items=0-10', 'bytes=9007199254740992-']) {
    assert.equal((await worker.fetch(new Request(publicUrl, { headers: { Range } }))).status, 416);
  }
});

test('cache failures leave native delivery intact and source stream failures never commit cache', async () => {
  const { createDownloadWorker } = await workerModule;
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const worker = createDownloadWorker({
    cache: { async match() { throw new Error('read failed'); }, async put() { throw new Error('write failed'); } },
    fetchImpl: async () => assetResponse(bytes)
  });
  const context = execution();
  const result = await worker.fetch(new Request(publicUrl), {}, context);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  await context.finish();
  const cache = memoryCache();
  const truncated = createDownloadWorker({ cache, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    pull(controller) { controller.error(new Error('upstream connection reset')); }
  }), { headers: { 'Content-Length': '100' } }) });
  const incompleteContext = execution();
  const incomplete = await truncated.fetch(new Request(publicUrl), {}, incompleteContext);
  await assert.rejects(incomplete.arrayBuffer(), /reset/);
  await incompleteContext.finish();
  assert.equal(cache.puts.length, 0);
});

test('large installers bypass cache fan-out and return the native upstream stream unchanged', async () => {
  const { createDownloadWorker } = await workerModule;
  let source;
  let put = false;
  let pulled = 0;
  const bytes = new Uint8Array(1024).fill(3);
  const worker = createDownloadWorker({
    cache: { async match() {}, async put() { put = true; } },
    fetchImpl: async () => {
      source = new Response(new ReadableStream({
        pull(controller) { pulled++; controller.enqueue(bytes); }
      }, { highWaterMark: 0 }), { headers: { 'Content-Length': '103871652' } });
      return source;
    }
  });
  const context = { waitUntil() { assert.fail('large installers must not schedule cache or body-pumping work'); } };
  const result = await worker.fetch(new Request(publicUrl), {}, context);
  assert.equal(result.body, source.body, 'native streaming must not run JavaScript per upstream chunk');
  assert.equal(pulled, 0, 'the Worker must not eagerly read the installer');
  assert.equal(put, false);
  assert.equal(result.headers.get('content-length'), '103871652');
  const reader = result.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 1024);
  await reader.cancel();
});

test('a stalled small-object cache cannot stall delivery and client responses cannot outlive authorization in caches', async () => {
  const { createDownloadWorker } = await workerModule;
  let releaseCache;
  const gate = new Promise(resolve => { releaseCache = resolve; });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const cache = {
    async match() {},
    async put(_key, response) {
      await gate;
      await response.arrayBuffer();
      assert.match(response.headers.get('cache-control'), /public/);
    }
  };
  const worker = createDownloadWorker({ cache, fetchImpl: async () => assetResponse(bytes) });
  const context = execution();
  const result = await worker.fetch(new Request(publicUrl), {}, context);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  assert.match(result.headers.get('cache-control'), /private, no-store/);
  assert.equal(result.headers.get('referrer-policy'), 'no-referrer');
  releaseCache();
  await context.finish();
});

test('authorization rejects missing, forged, expired, future and duplicate permits before cache or origin access', async () => {
  const { createDownloadWorker } = await realWorkerModule;
  let lookups = 0;
  let calls = 0;
  const worker = createDownloadWorker({
    cache: { async match() { lookups++; }, async put() {} },
    fetchImpl() { calls++; assert.fail('unauthorized requests must not fetch'); }
  });
  const forged = new URL(publicUrl);
  forged.searchParams.set('signature', 'a'.repeat(43));
  const swappedPath = publicUrl.replace('/v1.9.1/', '/v1.9.2/');
  const cases = [unsignedUrl, forged.href, swappedPath,
    signedUrl(unsignedUrl, Math.floor(Date.now() / 1000) - 1),
    signedUrl(unsignedUrl, Math.floor(Date.now() / 1000) + 3601),
    `${publicUrl}&expires=123`, `${publicUrl}&signature=${'b'.repeat(43)}`];
  for (const url of cases) {
    for (const method of ['GET', 'HEAD']) {
      const result = await worker.fetch(new Request(url, { method }), { DOWNLOAD_AUTH_SECRET: secret });
      assert.equal(result.status, 403, url);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(lookups, 0);
  assert.equal(calls, 0);
  for (const env of [undefined, {}, { DOWNLOAD_AUTH_SECRET: 'short' }]) {
    const result = await worker.fetch(new Request(publicUrl), env);
    assert.equal(result.status, 503);
  }
});

test('cached segments still require a valid permit and share storage across different verified visitors', async () => {
  const { createDownloadWorker } = await realWorkerModule;
  const cache = memoryCache();
  const bytes = new Uint8Array(segmentBytes).fill(42);
  let calls = 0;
  const worker = createDownloadWorker({ cache, fetchImpl: async () => {
    calls++;
    return assetResponse(bytes, { partial: true });
  } });
  const env = { DOWNLOAD_AUTH_SECRET: secret };
  const options = { headers: { Range: `bytes=0-${segmentBytes - 1}` } };
  const context = execution();
  const first = await worker.fetch(new Request(publicUrl, options), env, context);
  await first.arrayBuffer();
  await context.finish();
  const denied = await worker.fetch(new Request(unsignedUrl, options), env);
  assert.equal(denied.status, 403);
  const other = signedUrl(unsignedUrl, Math.floor(Date.now() / 1000) + 800);
  const hit = await worker.fetch(new Request(other, options), env);
  assert.equal(hit.status, 206);
  assert.equal(hit.headers.get('x-melody-cache'), 'HIT');
  assert.equal((await hit.arrayBuffer()).byteLength, segmentBytes);
  assert.equal(calls, 1);
  assert.equal(cache.puts.some(put => put.url.includes('signature=')), false);
});
