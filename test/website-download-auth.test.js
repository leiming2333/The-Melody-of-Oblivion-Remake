const test = require('node:test');
const assert = require('node:assert/strict');
const modulePromise = import('../website-download-auth.mjs');
const asset = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';

function authorization(now = Date.now()) {
  const expires = Math.floor(now / 1000) + 900;
  return {
    url: `https://downloads.melodyoblivion.xyz/releases/v1.9.1/${asset}?expires=${expires}&signature=${'a'.repeat(43)}`,
    expiresAt: new Date(expires * 1000).toISOString()
  };
}

function fixture({ enabled = true, serverResult = authorization(), serverStatus = 200 } = {}) {
  const calls = [], removed = [];
  let callbacks;
  const container = { replaceChildren() { this.cleared = true; } };
  const turnstile = {
    render(target, options) { assert.equal(target, container); callbacks = options; return 'widget-id'; },
    remove(id) { removed.push(id); }
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: url === '/api/download-config' || serverStatus === 200,
      json: async () => url === '/api/download-config'
        ? { enabled, siteKey: 'production-site-key', action: 'download' } : serverResult };
  };
  return { calls, removed, container, fetchImpl, turnstile, callbacks: () => callbacks,
    options: { tag: 'v1.9.1', asset, container, fetchImpl, loadTurnstile: async () => turnstile } };
}

test('only a Turnstile callback can authorize a signed Worker URL', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  const f = fixture();
  const pending = authorizeWebsiteDownload(f.options);
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 1);
  assert.equal(f.callbacks().action, 'download');
  f.callbacks().callback('one-use-token');
  const result = await pending;
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, '/api/download-authorization');
  assert.equal(f.calls[1].options.method, 'POST');
  assert.equal(f.calls[1].options.cache, 'no-store');
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { tag: 'v1.9.1', asset, turnstileToken: 'one-use-token' });
  assert.equal(new URL(result.url).hostname, 'downloads.melodyoblivion.xyz');
  assert.deepEqual(f.removed, ['widget-id']);
  assert.equal(f.container.cleared, true);
});

test('missing configuration never renders Turnstile or requests download authorization', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  const f = fixture({ enabled: false });
  await assert.rejects(authorizeWebsiteDownload(f.options), { code: 'DOWNLOAD_NOT_CONFIGURED' });
  assert.equal(f.callbacks(), undefined);
  assert.equal(f.calls.length, 1);
});

test('cancellation removes the widget and late callbacks cannot issue authorization', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  const f = fixture(), controller = new AbortController();
  const pending = authorizeWebsiteDownload({ ...f.options, signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  f.callbacks().callback('late-token');
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.removed, ['widget-id']);
  assert.equal(f.container.cleared, true);
});

test('expired, timed out, and failed challenges do not contact the authorization API', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  for (const callback of ['expired-callback', 'timeout-callback', 'error-callback']) {
    const f = fixture();
    const pending = authorizeWebsiteDownload(f.options);
    await new Promise(setImmediate);
    f.callbacks()[callback]();
    await assert.rejects(pending, error => /VERIFICATION_/.test(error.code));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.removed, ['widget-id']);
  }
});

test('a rejected server verification never supplies a usable download URL', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  const f = fixture({ serverStatus: 403, serverResult: { code: 'VERIFICATION_FAILED' } });
  const pending = authorizeWebsiteDownload(f.options);
  await new Promise(setImmediate);
  f.callbacks().callback('rejected-token');
  await assert.rejects(pending, { code: 'VERIFICATION_FAILED' });
  assert.deepEqual(f.removed, ['widget-id']);
});

test('the browser refuses altered, public, or expired signed URL metadata', async () => {
  const { validatedDownloadAuthorization } = await modulePromise;
  const valid = authorization();
  for (const value of [
    { ...valid, url: valid.url.replace('downloads.melodyoblivion.xyz', 'evil.example') },
    { ...valid, url: valid.url.replace('https:', 'http:') },
    { ...valid, url: valid.url.replace('/v1.9.1/', '/v1.9.0/') },
    { ...valid, url: valid.url + '&source=github' },
    { ...valid, url: valid.url.replace(/&signature=.*/, '') },
    { ...valid, url: valid.url + '#fragment' },
    { ...valid, expiresAt: new Date(Date.now() - 1).toISOString() },
    { ...valid, expiresAt: new Date(Date.now() + 120000).toISOString() }
  ]) {
    assert.throws(() => validatedDownloadAuthorization(value, 'v1.9.1', asset), { code: 'INVALID_AUTHORIZATION' });
  }
  assert.equal(validatedDownloadAuthorization(valid, 'v1.9.1', asset).url, valid.url);
});
