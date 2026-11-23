const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchTrustedInstallerChecksum } = require('../src/main/minecraft/installer-support');
const { fetchWithTimeout } = require('../src/main/minecraft/source-manager');
const { MinecraftLoaderManager } = require('../src/main/minecraft/loader-manager');

const officialUrl = 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.1.16/forge-1.21.1-52.1.16-installer.jar';
const digest = 'a'.repeat(64);

test('official checksum retries temporary failures against the same SHA-256 endpoint', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    if (requested.length === 1) throw new TypeError('fetch failed');
    if (requested.length === 2) return new Response('', { status: 503 });
    return new Response(digest);
  });
  const progress = [];
  const pending = fetchTrustedInstallerChecksum(officialUrl, undefined, (value) => progress.push(value));
  await new Promise(setImmediate);
  assert.equal(progress[0].attempt, 2);
  t.mock.timers.tick(500);
  await new Promise(setImmediate);
  assert.equal(progress[1].attempt, 3);
  t.mock.timers.tick(1000);
  assert.deepEqual(await pending, { algorithm: 'sha256', digest });
  assert.deepEqual(requested, Array(3).fill(`${officialUrl}.sha256`));
});

test('a checksum body taking longer than ten seconds can still complete', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    ok: true, status: 200,
    text: () => new Promise((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      started();
    })
  }));
  const pending = fetchTrustedInstallerChecksum(officialUrl);
  await reading;
  t.mock.timers.tick(15000);
  finish(digest);
  assert.deepEqual(await pending, { algorithm: 'sha256', digest });
});

test('cancelling during checksum retry delay stops before the next request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response('', { status: 503 });
  });
  const pending = fetchTrustedInstallerChecksum(officialUrl, controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await new Promise(setImmediate);
  controller.abort();
  await rejected;
  t.mock.timers.tick(60000);
  assert.deepEqual(requested, [`${officialUrl}.sha256`]);
});

test('nontransient HTTP failures and invalid official digests are not retried', async (t) => {
  for (const [status, body, code] of [
    [403, 'forbidden', 'NETWORK_ERROR'],
    [200, '<html>upstream error</html>', 'INSTALLER_CHECKSUM_INVALID']
  ]) {
    const requested = [];
    const mocked = t.mock.method(globalThis, 'fetch', async (url) => {
      requested.push(String(url));
      return new Response(body, { status });
    });
    await assert.rejects(fetchTrustedInstallerChecksum(officialUrl), { code });
    assert.deepEqual(requested, [`${officialUrl}.sha256`]);
    mocked.mock.restore();
  }
});

test('response-body timeout normalizes generic AbortError without reporting user cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    status: 200,
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
      started();
    })
  }));
  const pending = fetchWithTimeout('https://example.test/checksum', {}, 1000, (response) => response.text());
  const rejected = assert.rejects(pending, { name: 'TimeoutError', code: 'ETIMEDOUT', timeoutMs: 1000 });
  await reading;
  t.mock.timers.tick(1001);
  await rejected;
});

test('sequential loader metadata proceeds to its next official candidate after a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    requested.push(String(url));
    if (requested.length > 1) return new Response('{"version":"ok"}');
    return {
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
      })
    };
  });
  const manager = new MinecraftLoaderManager({ gameDirectory: 'unused', sourceManager: { downloadPreference: 'official' } });
  const pending = manager.fetchMetadata(['first', 'second'].map((id) => ({
    url: `https://example.test/${id}`, source: { id: 'official' }
  })), (response) => response.json());
  await reading;
  t.mock.timers.tick(10001);
  assert.deepEqual((await pending).data, { version: 'ok' });
  assert.deepEqual(requested, ['https://example.test/first', 'https://example.test/second']);
});

test('parallel loader metadata timeout failure is a network failure rather than cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const reading = new Promise((resolve) => { started = resolve; });
  let bodies = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    ok: true, status: 200,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      if (++bodies === 2) started();
    })
  }));
  const manager = new MinecraftLoaderManager({ gameDirectory: 'unused', sourceManager: { downloadPreference: 'auto' } });
  const pending = manager.fetchMetadata(['first', 'second'].map((id) => ({
    url: `https://example.test/${id}`, source: { id: 'official' }
  })), (response) => response.json());
  const rejected = assert.rejects(pending, (error) => {
    assert.notEqual(error.name, 'AbortError');
    assert.match(error.message, /加载器版本获取失败/);
    assert.match(error.message, /请求超时/);
    return true;
  });
  await reading;
  t.mock.timers.tick(10001);
  await rejected;
});
