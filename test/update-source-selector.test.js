const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { probeDownloadSource, rankDownloadCandidates } = require('../src/main/updater/update-source-selector');

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('source selection measures body throughput and keeps unresponsive fallbacks', async (t) => {
  const hits = new Map();
  const url = await serverFor(t, (request, response) => {
    hits.set(request.url, (hits.get(request.url) || 0) + 1);
    assert.equal(request.headers.range, 'bytes=0-4095');
    if (request.url === '/offline') return;
    response.writeHead(206, { 'content-range': 'bytes 0-4095/100000', 'content-length': 4096 });
    if (request.url === '/fast') response.end(Buffer.alloc(4096));
    else {
      response.write(Buffer.alloc(1024));
      const timer = setTimeout(() => response.end(Buffer.alloc(3072)), 300);
      response.on('close', () => clearTimeout(timer));
    }
  });
  const candidates = ['slow', 'offline', 'fast'].map((name) => ({ url: `${url}/${name}`, enforceMinSpeed: true }));
  candidates.push({ url: `${url}/offline`, enforceMinSpeed: false });
  const ranked = await rankDownloadCandidates(candidates, { expectedSize: 100000, sampleBytes: 4096, timeoutMs: 650 });
  assert.deepEqual(ranked.slice(0, 3).map((candidate) => candidate.url), [`${url}/fast`, `${url}/slow`, `${url}/offline`]);
  assert.equal(ranked.at(-2).url, `${url}/fast`);
  assert.equal(ranked.at(-2).enforceMinSpeed, false);
  assert.equal(ranked.at(-1).enforceMinSpeed, false);
  assert.equal(hits.get('/offline'), 1);
  assert.ok(ranked[1].minSpeedBytesPerSecond > 0 && ranked[1].minSpeedBytesPerSecond < 100 * 1024);
});

test('a slow probe still contributes its partial sample at the deadline', async (t) => {
  const url = await serverFor(t, (_request, response) => {
    response.writeHead(206, { 'content-range': 'bytes 0-4095/100000' });
    response.write(Buffer.alloc(1024));
  });
  const sample = await probeDownloadSource(url, { expectedSize: 100000, sampleBytes: 4096, timeoutMs: 300 });
  assert.ok(sample.bytesPerSecond > 0 && sample.bytesPerSecond < 10000);
});

test('ignored Range responses are sampled without reading the entire package', async () => {
  let reads = 0;
  let cancelled = false;
  const fetchImpl = async () => new Response(new ReadableStream({
    pull(controller) { reads += 1; controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancelled = true; }
  }), { headers: { 'content-length': '100000000' } });
  const sample = await probeDownloadSource('https://fixture.invalid/', {
    expectedSize: 100000000, sampleBytes: 4096, fetchImpl
  });
  assert.ok(sample.bytesPerSecond > 0);
  assert.ok(reads <= 6);
  assert.equal(cancelled, true);
});

test('wrong ranges, wrong package sizes and mirror error pages do not win probes', async () => {
  for (const response of [
    new Response('error', { status: 206, headers: { 'content-range': 'bytes 0-4095/99999' } }),
    new Response('error', { headers: { 'content-length': '5' } }),
    new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } })
  ]) {
    assert.equal(await probeDownloadSource('https://fixture.invalid/', {
      expectedSize: 100000, sampleBytes: 4096, fetchImpl: async () => response
    }), null);
  }
});

test('unavailable probes preserve all original download fallbacks', async () => {
  const candidates = [
    { url: 'https://fixture.invalid/a', enforceMinSpeed: true },
    { url: 'https://fixture.invalid/b', enforceMinSpeed: true },
    { url: 'https://fixture.invalid/b', enforceMinSpeed: false }
  ];
  assert.equal(await rankDownloadCandidates(candidates, {
    fetchImpl: async () => { throw new Error('offline'); }
  }), candidates);
});

test('cancelling source selection aborts and awaits every active probe', async () => {
  const controller = new AbortController();
  let active = 0;
  const candidates = ['a', 'b', 'c'].map((name) => ({ url: `https://fixture.invalid/${name}`, enforceMinSpeed: true }));
  const ranking = rankDownloadCandidates(candidates, {
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
      active += 1;
      signal.addEventListener('abort', () => {
        active -= 1;
        reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      }, { once: true });
    })
  });
  assert.equal(active, 3);
  controller.abort();
  await assert.rejects(ranking, { name: 'AbortError' });
  assert.equal(active, 0);
});
