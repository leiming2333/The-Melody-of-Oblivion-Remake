const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { downloadToFile } = require('../src/main/updater/update-downloader');

async function fixture(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-update-ranges-'));
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, target: path.join(directory, 'update.part') };
}

const payload = Buffer.alloc(4 * 1024 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 23 + Math.floor(i / 65536)) % 251;
const digest = crypto.createHash('sha256').update(payload).digest('hex');
const options = { expectedSize: payload.length, sha256: digest, enforceMinSpeed: false };

function requestedRange(request) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
  return match ? { start: Number(match[1]), end: Number(match[2]) } : null;
}

function rangeHeaders(range) {
  return { 'content-range': `bytes ${range.start}-${range.end}/${payload.length}`,
    'content-length': range.end - range.start + 1 };
}

test('large updates download concurrently and assemble exactly the requested bytes', async t => {
  let active = 0;
  let peak = 0;
  const requests = [];
  const { url, target } = await fixture(t, (request, response) => {
    const range = requestedRange(request);
    requests.push(range);
    assert.ok(range);
    response.writeHead(206, rangeHeaders(range));
    if (range.end === 0) return response.end(payload.subarray(0, 1));
    peak = Math.max(peak, ++active);
    const timer = setTimeout(() => response.end(payload.subarray(range.start, range.end + 1)), 30);
    response.on('close', () => { active -= 1; clearTimeout(timer); });
  });
  const progress = [];
  await downloadToFile(url, target, value => progress.push(value), options);
  assert.ok(peak > 1);
  assert.equal(requests.length, 5);
  assert.equal(progress.at(-1), 100);
  assert.deepEqual(await fs.readFile(target), payload);
});

test('a server ignoring Range reuses its full response for a safe single stream', async t => {
  let requests = 0;
  const { url, target } = await fixture(t, (_request, response) => {
    requests += 1;
    response.writeHead(200, { 'content-length': payload.length });
    response.end(payload);
  });
  await downloadToFile(url, target, undefined, options);
  assert.equal(requests, 1);
  assert.deepEqual(await fs.readFile(target), payload);
});

test('incorrect Content-Range cancels the segments and falls back to a complete response', async t => {
  let fullRequests = 0;
  const { url, target } = await fixture(t, (request, response) => {
    const range = requestedRange(request);
    if (!range) {
      fullRequests += 1;
      response.writeHead(200, { 'content-length': payload.length });
      return response.end(payload);
    }
    response.writeHead(206, range.end === 0 ? rangeHeaders(range)
      : { ...rangeHeaders(range), 'content-range': `bytes 0-${range.end}/${payload.length}` });
    response.end(payload.subarray(range.start, range.end + 1));
  });
  await downloadToFile(url, target, undefined, options);
  assert.equal(fullRequests, 1);
  assert.deepEqual(await fs.readFile(target), payload);
});

test('a dishonest one-byte Range probe cannot start segmented writes', async t => {
  let rangeRequests = 0;
  let fullRequests = 0;
  const { url, target } = await fixture(t, (request, response) => {
    const range = requestedRange(request);
    if (range) {
      rangeRequests += 1;
      response.writeHead(206, { ...rangeHeaders(range), 'content-length': 2 });
      return response.end('ab');
    }
    fullRequests += 1;
    response.writeHead(200, { 'content-length': payload.length });
    response.end(payload);
  });
  await downloadToFile(url, target, undefined, options);
  assert.equal(rangeRequests, 1);
  assert.equal(fullRequests, 1);
  assert.deepEqual(await fs.readFile(target), payload);
});

test('probe and segment connection delays do not count as slow body transfers', async t => {
  const { url, target } = await fixture(t, (request, response) => {
    const range = requestedRange(request);
    const timer = setTimeout(() => {
      response.writeHead(206, rangeHeaders(range));
      response.end(payload.subarray(range.start, range.end + 1));
    }, 60);
    response.on('close', () => clearTimeout(timer));
  });
  await downloadToFile(url, target, undefined, {
    ...options, enforceMinSpeed: true, connectTimeoutMs: 500,
    slowGraceMs: 100, speedWindowMs: 20
  });
  assert.deepEqual(await fs.readFile(target), payload);
});

test('switching sources keeps completed ranges for the same trusted update', async t => {
  const secondRanges = [];
  const { url, target } = await fixture(t, (request, response) => {
    const range = requestedRange(request);
    assert.ok(range);
    if (request.url === '/second') secondRanges.push(range);
    response.writeHead(206, rangeHeaders(range));
    if (request.url === '/first' && range.start > 0) {
      response.write(payload.subarray(range.start, range.start + 32));
      const timer = setTimeout(() => response.destroy(), 100);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    response.end(payload.subarray(range.start, range.end + 1));
  });
  const resumeState = {};
  await assert.rejects(downloadToFile(`${url}/first`, target, undefined, { ...options, resumeState }));
  assert.equal(resumeState.completed.size, 1);
  await downloadToFile(`${url}/second`, target, undefined, { ...options, resumeState });
  assert.equal(secondRanges.length, 4); // One support probe and three unfinished segments.
  assert.ok(!secondRanges.some(range => range.start === 0 && range.end > 0));
  assert.deepEqual(await fs.readFile(target), payload);
});

test('a changed update digest discards all previously completed ranges', async t => {
  const seen = [];
  const { url, target } = await fixture(t, (request, response) => {
    const range = requestedRange(request);
    seen.push(range);
    response.writeHead(206, rangeHeaders(range));
    response.end(payload.subarray(range.start, range.end + 1));
  });
  const resumeState = {};
  await downloadToFile(url, target, undefined, { ...options, resumeState });
  seen.length = 0;
  await downloadToFile(url, target, undefined, { ...options, sha256: 'a'.repeat(64), resumeState });
  assert.equal(seen.length, 5);
});

test('cancelling a segmented update stops its sibling transfers before returning', async t => {
  const controller = new AbortController();
  const { url, target } = await fixture(t, (request, response) => {
    const range = requestedRange(request);
    response.writeHead(206, rangeHeaders(range));
    if (range.end === 0) return response.end(payload.subarray(0, 1));
    response.write(payload.subarray(range.start, range.start + 32));
    setTimeout(() => controller.abort(), 20).unref();
  });
  await assert.rejects(downloadToFile(url, target, undefined, { ...options, signal: controller.signal }), {
    name: 'AbortError', code: 'ABORT_ERR'
  });
  const size = (await fs.stat(target)).size;
  assert.equal(size, payload.length);
  const afterCancel = await fs.readFile(target);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(await fs.readFile(target), afterCancel);
});

test('single streams retain connection and stalled-body deadlines', async t => {
  const { url, target } = await fixture(t, (request, response) => {
    if (request.url === '/stall') {
      response.writeHead(200, { 'content-length': 5 });
      response.write('a');
    }
  });
  await assert.rejects(downloadToFile(`${url}/connect`, target, undefined, {
    enforceMinSpeed: false, connectTimeoutMs: 40, stallTimeoutMs: 300
  }), { code: 'CONNECT_TIMEOUT' });
  await assert.rejects(downloadToFile(`${url}/stall`, target, undefined, {
    enforceMinSpeed: false, connectTimeoutMs: 1000, stallTimeoutMs: 40
  }), { code: 'STALL_SOURCE' });
});

test('aggregate low-speed detection aborts a download using its configured threshold', async t => {
  const { url, target } = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 100000 });
    response.write('a');
    const timer = setInterval(() => response.write('a'), 15);
    response.on('close', () => clearInterval(timer));
  });
  await assert.rejects(downloadToFile(url, target, undefined, {
    connectTimeoutMs: 1000, stallTimeoutMs: 1000, slowGraceMs: 60,
    speedWindowMs: 30, minSpeedBytesPerSecond: 10000
  }), { code: 'SLOW_SOURCE' });
});
