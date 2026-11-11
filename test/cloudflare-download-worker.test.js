const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const websiteCdnConfig = require('../src/shared/website-cdn-config.json');

const filename = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';
const tag = 'v1.9.3';
const unsignedUrl = `${websiteCdnConfig.baseUrl}/releases/${tag}/${filename}`;
const secret = 'unit-test-worker-authorization-secret-at-least-32';
const env = { DOWNLOAD_AUTH_SECRET: secret };
const r2Url = `https://downloads.melodyoblivion.xyz/releases/${tag}/${filename}`;
const blobUrl = `https://4rgpxcwwpeiy2uij.public.blob.vercel-storage.com/releases/${tag}/${filename}`;
const githubUrl = `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${tag}/${filename}`;
const segmentBytes = 1024 * 1024;
const workerModule = import('../cloudflare/download-worker.mjs');

function signedUrl(value = unsignedUrl, expires = Math.floor(Date.now() / 1000) + 900) {
  const url = new URL(value);
  const signature = createHmac('sha256', secret).update(`download-v1\n${url.pathname}\n${expires}`).digest('base64url');
  url.searchParams.set('expires', expires);
  url.searchParams.set('signature', signature);
  return url.href;
}

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
      // Cloudflare refuses 206 in cache.put. Store ranges as internal 200s.
      assert.equal(response.status, 200);
      assert.equal(response.headers.has('content-range'), false);
      const entry = { bytes: new Uint8Array(await response.arrayBuffer()), headers: new Headers(response.headers) };
      entries.set(key.url, entry);
      puts.push({ url: key.url, length: entry.bytes.length, headers: entry.headers });
    },
    async match(key) {
      const entry = entries.get(key.url);
      if (!entry) return undefined;
      const range = key.headers.get('range');
      if (range) {
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
        const headers = new Headers(entry.headers);
        headers.set('Content-Range', `bytes ${start}-${end}/${entry.bytes.length}`);
        headers.set('Content-Length', String(end - start + 1));
        return new Response(entry.bytes.slice(start, end + 1), { status: 206, headers });
      }
      return new Response(entry.bytes.slice(), { headers: entry.headers });
    }
  };
}

function assetResponse(bytes, { start = 0, end = bytes.length - 1, partial = false } = {}) {
  return new Response(bytes.slice(start, end + 1), {
    status: partial ? 206 : 200,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(end - start + 1),
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }
  });
}

test('only pinned protected release paths can invoke the gateway; public update URLs are excluded', async () => {
  const { createDownloadWorker } = await workerModule;
  let calls = 0;
  const worker = createDownloadWorker({ cache: null, fetchImpl() { calls++; assert.fail('must not fetch'); } });
  for (const path of ['/', '/releases/latest.json', `/releases/latest/${filename}`,
    `/releases/${tag}/${filename}?url=https://evil.example`, `/releases/${tag}/arbitrary.exe`,
    `/releases/${tag}/${filename}/extra`, `/releases/${tag}/%2e%2e%2f${filename}`]) {
    const result = await worker.fetch(new Request(`${websiteCdnConfig.baseUrl}${path}`), env);
    assert.equal(result.status, 404);
  }
  for (const url of [r2Url, 'https://downloads.melodyoblivion.xyz/releases/latest.json',
    `https://evil.example/releases/${tag}/${filename}`, `https://www.melodyoblivion.xyz/releases/${tag}/${filename}`]) {
    assert.equal((await worker.fetch(new Request(signedUrl(url)), env)).status, 404);
  }
  assert.equal((await worker.fetch(new Request(signedUrl(), { method: 'POST', body: 'x' }), env)).status, 405);
  const preflight = await worker.fetch(new Request(unsignedUrl, { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Range/);
  assert.equal(calls, 0);
});

test('HEAD forwards no body, Range, cookies, or browser credentials and preserves full length', async () => {
  const { createDownloadWorker } = await workerModule;
  const worker = createDownloadWorker({ cache: null, fetchImpl: async (url, options) => {
    assert.equal(url, r2Url);
    assert.equal(options.method, 'HEAD');
    assert.equal(options.headers.get('range'), null);
    assert.equal(options.headers.get('cookie'), null);
    assert.equal(options.headers.get('authorization'), null);
    return new Response(null, { headers: { 'Content-Length': '103873852' } });
  } });
  const result = await worker.fetch(new Request(signedUrl(), { method: 'HEAD', headers: { Range: 'bytes=0-100' } }), env);
  assert.equal(result.status, 200);
  assert.equal(result.body, null);
  assert.equal(result.headers.get('content-length'), '103873852');
  assert.equal(result.headers.get('access-control-allow-origin'), '*');
  assert.equal(result.headers.get('x-melody-source'), 'R2');
  assert.match(result.headers.get('cache-control'), /private, no-store, no-transform/);
});

test('HEAD cache hits never read installer bytes or schedule body work', async () => {
  const { createDownloadWorker } = await workerModule;
  let cancelled = false;
  const worker = createDownloadWorker({
    cache: { async match() {
      return new Response(new ReadableStream({
        pull() { assert.fail('HEAD must not read the cache body'); },
        cancel() { cancelled = true; }
      }, { highWaterMark: 0 }), { headers: { 'Content-Length': '103873852' } });
    }, async put() { assert.fail('HEAD must not cache'); } },
    fetchImpl() { assert.fail('cached HEAD must not fetch'); }
  });
  const result = await worker.fetch(new Request(signedUrl(), { method: 'HEAD' }), env,
    { waitUntil() { assert.fail('HEAD must not schedule work'); } });
  assert.equal(result.body, null);
  assert.equal(result.headers.get('x-melody-cache'), 'HIT');
  assert.equal(result.headers.get('content-length'), '103873852');
  assert.equal(cancelled, true);
});

test('small full responses cache and subsequent HEAD/Range requests need no origin', async () => {
  const { createDownloadWorker } = await workerModule;
  const cache = memoryCache();
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  let calls = 0;
  const worker = createDownloadWorker({ cache, fetchImpl: async () => { calls++; return assetResponse(bytes); } });
  const context = execution();
  const first = await worker.fetch(new Request(signedUrl()), env, context);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), bytes);
  await context.finish();
  assert.equal(cache.puts.length, 1);
  const head = await worker.fetch(new Request(signedUrl(), { method: 'HEAD' }), env);
  assert.equal(head.body, null);
  assert.equal(head.headers.get('x-melody-cache'), 'HIT');
  const range = await worker.fetch(new Request(signedUrl(), { headers: { Range: 'bytes=2-5' } }), env);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/8');
  assert.deepEqual(new Uint8Array(await range.arrayBuffer()), bytes.slice(2, 6));
  assert.equal(calls, 1);
});

test('aligned 1 MiB parts and final parts cache as internal 200 and restore exact 206', async () => {
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
    const first = await worker.fetch(new Request(signedUrl(), options), env, context);
    assert.equal(first.status, 206);
    assert.equal((await first.arrayBuffer()).byteLength, end - start + 1);
    await context.finish();
    const hit = await worker.fetch(new Request(signedUrl(), options), env);
    assert.equal(hit.status, 206);
    assert.equal(hit.headers.get('x-melody-cache'), 'HIT');
    assert.equal(hit.headers.get('content-range'), `bytes ${start}-${end}/${bytes.length}`);
    assert.equal((await hit.arrayBuffer()).byteLength, end - start + 1);
  }
  assert.equal(calls, 2);
  assert.deepEqual(cache.puts.map(put => put.length), [segmentBytes, 17]);
});

test('probes, suffix/open ranges, and If-Range do not fragment the aligned-part cache', async () => {
  const { createDownloadWorker } = await workerModule;
  const bytes = new Uint8Array(segmentBytes * 2).fill(7);
  const cache = memoryCache();
  const worker = createDownloadWorker({ cache, fetchImpl: async (_url, options) => {
    const value = options.headers.get('range');
    if (value === 'bytes=0-32767') return assetResponse(bytes, { start: 0, end: 32767, partial: true });
    if (value === 'bytes=-8' || value === `bytes=${bytes.length - 8}-`) {
      return assetResponse(bytes, { start: bytes.length - 8, partial: true });
    }
    assert.equal(options.headers.get('if-range'), '"version"');
    return assetResponse(bytes);
  } });
  for (const range of ['bytes=0-32767', 'bytes=-8', `bytes=${bytes.length - 8}-`]) {
    const context = execution();
    const result = await worker.fetch(new Request(signedUrl(), { headers: { Range: range } }), env, context);
    assert.equal(result.status, 206);
    await result.arrayBuffer();
    await context.finish();
  }
  const result = await worker.fetch(new Request(signedUrl(), { headers: { Range: 'bytes=0-1', 'If-Range': '"version"' } }), env);
  assert.equal(result.status, 200);
  await result.arrayBuffer();
  assert.equal(cache.puts.length, 0);
});

test('R2 failures fall back to fixed Blob/GitHub sources without exposing redirects or the permit', async () => {
  const { createDownloadWorker } = await workerModule;
  const assetUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/abc?signature=github';
  const calls = [];
  const worker = createDownloadWorker({ cache: null, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.get('authorization'), null);
    assert.ok(!url.includes('expires='));
    if ([r2Url, blobUrl].includes(url)) return new Response('unavailable', { status: 503 });
    if (url === githubUrl) return new Response(null, { status: 302, headers: { Location: assetUrl } });
    assert.equal(url, assetUrl);
    return assetResponse(new Uint8Array([1, 2, 3]));
  } });
  const result = await worker.fetch(new Request(signedUrl()), env);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('location'), null);
  assert.equal(result.headers.get('x-melody-source'), 'GitHub');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(calls, [r2Url, blobUrl, githubUrl, assetUrl]);
});

test('unapproved redirects, error pages, compressed bodies, and wrong ranges never enter cache', async () => {
  const { createDownloadWorker } = await workerModule;
  for (const responseFor of [
    () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/package.exe' } }),
    () => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('data', { headers: { 'Content-Encoding': 'gzip' } }),
    () => new Response('abcd', { status: 206, headers: { 'Content-Range': 'bytes 1-4/20', 'Content-Length': '4' } }),
    () => new Response('error', { status: 500 }), () => new Response('missing', { status: 404 })
  ]) {
    const cache = memoryCache();
    const worker = createDownloadWorker({ cache, fetchImpl: async () => responseFor() });
    const result = await worker.fetch(new Request(signedUrl(), { headers: { Range: 'bytes=0-3' } }), env, execution());
    assert.ok([404, 502].includes(result.status));
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), '*');
    assert.equal(cache.puts.length, 0);
  }
});

test('invalid and multi-range requests fail before reading the origin', async () => {
  const { createDownloadWorker } = await workerModule;
  const worker = createDownloadWorker({ cache: null, fetchImpl() { assert.fail('must not fetch'); } });
  for (const Range of ['bytes=0-1,3-4', 'bytes=2-1', 'bytes=-0', 'bytes=-', 'items=0-10', 'bytes=9007199254740992-']) {
    assert.equal((await worker.fetch(new Request(signedUrl(), { headers: { Range } }), env)).status, 416);
  }
});

test('cache failures cannot interrupt delivery and a failed source stream never commits cache', async () => {
  const { createDownloadWorker } = await workerModule;
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const worker = createDownloadWorker({
    cache: { async match() { throw new Error('read failed'); }, async put() { throw new Error('write failed'); } },
    fetchImpl: async () => assetResponse(bytes)
  });
  const context = execution();
  const result = await worker.fetch(new Request(signedUrl()), env, context);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  await context.finish();
  const cache = memoryCache();
  const truncated = createDownloadWorker({ cache, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    pull(controller) { controller.error(new Error('upstream reset')); }
  }), { headers: { 'Content-Length': '100' } }) });
  const incompleteContext = execution();
  const incomplete = await truncated.fetch(new Request(signedUrl()), env, incompleteContext);
  await assert.rejects(incomplete.arrayBuffer(), /reset/);
  await incompleteContext.finish();
  assert.equal(cache.puts.length, 0);
});

test('large installers return native streams without eager reads, timers, or cache fan-out', async () => {
  const { createDownloadWorker } = await workerModule;
  let source;
  let sourceSignal;
  let put = false;
  let pulled = 0;
  const worker = createDownloadWorker({
    cache: { async match() {}, async put() { put = true; } },
    fetchImpl: async (_url, options) => {
      sourceSignal = options.signal;
      source = new Response(new ReadableStream({ pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024));
      } }, { highWaterMark: 0 }), { headers: { 'Content-Length': '103873852' } });
      return source;
    }
  });
  const result = await worker.fetch(new Request(signedUrl()), env,
    { waitUntil() { assert.fail('large files must not schedule cache/body work'); } });
  assert.equal(result.body, source.body);
  assert.equal(pulled, 0);
  assert.equal(put, false);
  assert.equal(sourceSignal.aborted, false);
  const reader = result.body.getReader();
  assert.equal((await reader.read()).value.byteLength, 1024);
  await reader.cancel();
});

test('slow cache writes cannot stall native delivery and client caches cannot outlive permits', async () => {
  const { createDownloadWorker } = await workerModule;
  let releaseCache;
  const gate = new Promise(resolve => { releaseCache = resolve; });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const worker = createDownloadWorker({ cache: { async match() {}, async put(_key, response) {
    await gate;
    await response.arrayBuffer();
    assert.match(response.headers.get('cache-control'), /public/);
  } }, fetchImpl: async () => assetResponse(bytes) });
  const context = execution();
  const result = await worker.fetch(new Request(signedUrl()), env, context);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  assert.match(result.headers.get('cache-control'), /private, no-store/);
  releaseCache();
  await context.finish();
});

test('missing, forged, expired, future, and duplicate permits fail before cache/origin access', async () => {
  const { createDownloadWorker } = await workerModule;
  let lookups = 0;
  let calls = 0;
  const worker = createDownloadWorker({ cache: { async match() { lookups++; }, async put() {} },
    fetchImpl() { calls++; assert.fail('must not fetch'); } });
  const valid = signedUrl();
  const forged = new URL(valid);
  forged.searchParams.set('signature', 'a'.repeat(43));
  const cases = [unsignedUrl, forged.href, valid.replace(`/${tag}/`, '/v1.9.2/'),
    signedUrl(unsignedUrl, Math.floor(Date.now() / 1000) - 1),
    signedUrl(unsignedUrl, Math.floor(Date.now() / 1000) + 3601),
    `${valid}&expires=123`, `${valid}&signature=${'b'.repeat(43)}`];
  for (const url of cases) {
    for (const method of ['GET', 'HEAD']) {
      const result = await worker.fetch(new Request(url, { method }), env);
      assert.equal(result.status, 403);
      assert.equal(result.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(lookups, 0);
  assert.equal(calls, 0);
  for (const missing of [undefined, {}, { DOWNLOAD_AUTH_SECRET: 'short' }]) {
    assert.equal((await worker.fetch(new Request(valid), missing)).status, 503);
  }
});

test('cached parts are shared by verified visitors but still require fresh permits', async () => {
  const { createDownloadWorker } = await workerModule;
  const cache = memoryCache();
  const bytes = new Uint8Array(segmentBytes).fill(42);
  let calls = 0;
  const worker = createDownloadWorker({ cache, fetchImpl: async () => { calls++; return assetResponse(bytes, { partial: true }); } });
  const options = { headers: { Range: `bytes=0-${segmentBytes - 1}` } };
  const context = execution();
  const first = await worker.fetch(new Request(signedUrl(), options), env, context);
  await first.arrayBuffer();
  await context.finish();
  assert.equal((await worker.fetch(new Request(unsignedUrl, options), env)).status, 403);
  const other = signedUrl(unsignedUrl, Math.floor(Date.now() / 1000) + 800);
  const hit = await worker.fetch(new Request(other, options), env);
  assert.equal(hit.status, 206);
  assert.equal(hit.headers.get('x-melody-cache'), 'HIT');
  assert.equal((await hit.arrayBuffer()).byteLength, segmentBytes);
  assert.equal(calls, 1);
  assert.equal(cache.puts.some(put => put.url.includes('signature=')), false);
});

test('secret rotation rejects old signed requests even if the installer remains cached', async () => {
  const { createDownloadWorker } = await workerModule;
  const cache = memoryCache();
  const bytes = new Uint8Array([1, 2, 3]);
  let calls = 0;
  const worker = createDownloadWorker({ cache, fetchImpl: async () => { calls++; return assetResponse(bytes); } });
  const oldPermit = signedUrl();
  const context = execution();
  const first = await worker.fetch(new Request(oldPermit), env, context);
  await first.arrayBuffer();
  await context.finish();
  const rotatedSecret = `${secret}-rotated`;
  const rotatedEnv = { DOWNLOAD_AUTH_SECRET: rotatedSecret };
  assert.equal((await worker.fetch(new Request(oldPermit), rotatedEnv)).status, 403);
  const url = new URL(oldPermit);
  const expires = url.searchParams.get('expires');
  url.searchParams.set('signature', createHmac('sha256', rotatedSecret)
    .update(`download-v1\n${url.pathname}\n${expires}`).digest('base64url'));
  const hit = await worker.fetch(new Request(url.href), rotatedEnv);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('x-melody-cache'), 'HIT');
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), bytes);
  assert.equal(calls, 1);
});

test('the gateway supports all configured bases and the API produces compatible signatures', async () => {
  const { createDownloadWorker } = await workerModule;
  const { createDownloadTarget } = require('../api/download-authorization');
  const bytes = new Uint8Array([1, 2, 3]);
  const worker = createDownloadWorker({ cache: null, fetchImpl: async () => assetResponse(bytes) });
  for (const baseUrl of websiteCdnConfig.allowedBases) {
    const permit = createDownloadTarget({ baseUrl, authSecret: secret, ttl: 900 }, tag, filename);
    const result = await worker.fetch(new Request(permit.url), env);
    assert.equal(result.status, 200);
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  }
});

test('deployment config never claims the existing public R2 domain', () => {
  const fs = require('node:fs');
  const config = JSON.parse(fs.readFileSync(require.resolve('../cloudflare/wrangler.jsonc'), 'utf8'));
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.routes, undefined);
  assert.equal(config.vars, undefined);
});
