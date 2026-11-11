const test = require('node:test');
const assert = require('node:assert/strict');
const websiteCdnConfig = require('../src/shared/website-cdn-config.json');

const modulePromise = import('../website-download-auth.mjs');
const tag = 'v1.9.3';
const asset = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';
const expectedUrl = `${websiteCdnConfig.baseUrl}/releases/${tag}/${asset}`;
function authorization(url = expectedUrl, expires = Math.floor(Date.now() / 1000) + 900) {
  return { url: `${url}?expires=${expires}&signature=${'s'.repeat(43)}`, expiresAt: new Date(expires * 1000).toISOString() };
}

function fixture({ enabled = true, baseUrl = websiteCdnConfig.baseUrl, serverResult = authorization(), serverStatus = 200 } = {}) {
  const calls = [];
  const removed = [];
  let callbacks;
  const container = { replaceChildren() { this.cleared = true; } };
  const turnstile = {
    render(target, options) {
      assert.equal(target, container);
      callbacks = options;
      return 'widget-id';
    },
    remove(id) { removed.push(id); }
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: url === '/api/download-config' || serverStatus === 200,
      json: async () => url === '/api/download-config'
         ? { enabled, siteKey: 'fixture-site-key', action: 'download', baseUrl } : serverResult
    };
  };
  return {
    calls, removed, container, turnstile, callbacks: () => callbacks,
    options: { tag, asset, expectedUrl, container, fetchImpl, loadTurnstile: async () => turnstile }
  };
}

test('only a Turnstile callback can authorize the exact protected signed URL', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  const fixtureData = fixture();
  const pending = authorizeWebsiteDownload(fixtureData.options);
  await new Promise(setImmediate);
  assert.equal(fixtureData.calls.length, 1);
  assert.equal(fixtureData.callbacks().action, 'download');
  assert.equal(fixtureData.callbacks().sitekey, 'fixture-site-key');
  fixtureData.callbacks().callback('one-use-token');
  const result = await pending;
  assert.ok(result.url.startsWith(`${expectedUrl}?expires=`));
  assert.equal(new URL(result.url).searchParams.get('signature'), 's'.repeat(43));
  assert.equal(fixtureData.calls.length, 2);
  assert.equal(fixtureData.calls[1].url, '/api/download-authorization');
  assert.equal(fixtureData.calls[1].options.method, 'POST');
  assert.equal(fixtureData.calls[1].options.cache, 'no-store');
  assert.deepEqual(JSON.parse(fixtureData.calls[1].options.body), {
    tag, asset, turnstileToken: 'one-use-token'
  });
  assert.deepEqual(fixtureData.removed, ['widget-id']);
  assert.equal(fixtureData.container.cleared, true);
});

test('disabled configuration never renders Turnstile or sends an authorization request', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  const fixtureData = fixture({ enabled: false });
  await assert.rejects(authorizeWebsiteDownload(fixtureData.options), { code: 'DOWNLOAD_NOT_CONFIGURED' });
  assert.equal(fixtureData.callbacks(), undefined);
  assert.equal(fixtureData.calls.length, 1);
});

test('expired, timed out, and failed widget callbacks do not contact the authorization API', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  for (const callback of ['expired-callback', 'timeout-callback', 'error-callback']) {
    const fixtureData = fixture();
    const pending = authorizeWebsiteDownload(fixtureData.options);
    await new Promise(setImmediate);
    fixtureData.callbacks()[callback]();
    await assert.rejects(pending, error => /VERIFICATION_/.test(error.code));
    assert.equal(fixtureData.calls.length, 1);
    assert.deepEqual(fixtureData.removed, ['widget-id']);
  }
});

test('cancellation removes the widget and a late callback cannot authorize a download', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  const fixtureData = fixture();
  const controller = new AbortController();
  const pending = authorizeWebsiteDownload({ ...fixtureData.options, signal: controller.signal });
  await new Promise(setImmediate);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  fixtureData.callbacks().callback('late-token');
  await new Promise(setImmediate);
  assert.equal(fixtureData.calls.length, 1);
  assert.deepEqual(fixtureData.removed, ['widget-id']);
  assert.equal(fixtureData.container.cleared, true);
});

test('a rejected server response never supplies a usable URL', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  const fixtureData = fixture({ serverStatus: 403, serverResult: { code: 'VERIFICATION_FAILED' } });
  const pending = authorizeWebsiteDownload(fixtureData.options);
  await new Promise(setImmediate);
  fixtureData.callbacks().callback('rejected-token');
  await assert.rejects(pending, { code: 'VERIFICATION_FAILED' });
  assert.deepEqual(fixtureData.removed, ['widget-id']);
});

test('the browser rejects unsigned, expired, malformed, or mismatched download permits', async () => {
  const { validatedDownloadAuthorization } = await modulePromise;
  const valid = authorization();
  const changed = value => ({ ...valid, ...value });
  for (const value of [
    null, {}, { authorized: true }, { url: expectedUrl },
    changed({ url: valid.url.replace('verified-downloads.melodyoblivion.xyz', 'evil.example') }),
    changed({ url: valid.url.replace('verified-downloads.', 'downloads.') }),
    changed({ url: valid.url.replace('https:', 'http:') }),
    changed({ url: valid.url.replace(`/${tag}/`, '/v1.9.2/') }),
    changed({ url: `${valid.url}&asset=other.exe` }),
    changed({ url: `${valid.url}#fragment` }),
    changed({ url: valid.url.replace(`${asset}?`, `${asset}/extra?`) }),
    changed({ url: `${valid.url}&expires=123` }),
    changed({ url: `${valid.url}&signature=${'s'.repeat(43)}` }),
    changed({ url: valid.url.replace('s'.repeat(43), 'invalid') }),
    changed({ expiresAt: undefined }), changed({ expiresAt: new Date(0).toISOString() }),
    authorization(expectedUrl, Math.floor(Date.now() / 1000) - 1),
    authorization(expectedUrl, Math.floor(Date.now() / 1000) + 3601)
  ]) {
    assert.throws(() => validatedDownloadAuthorization(value, tag, asset, expectedUrl), {
      code: 'INVALID_AUTHORIZATION'
    });
  }
  assert.deepEqual(validatedDownloadAuthorization(valid, tag, asset, expectedUrl), valid);
});

test('browser base allowlist matches the API, excludes public R2, and supports protected path routes', async () => {
  const { validatedDownloadBaseUrl, validatedDownloadAuthorization } = await modulePromise;
  for (const base of websiteCdnConfig.allowedBases) {
    assert.equal(validatedDownloadBaseUrl(base), base);
    assert.equal(validatedDownloadBaseUrl(`${base}/`), base);
    const expected = `${base}/releases/${tag}/${asset}`;
    const signed = authorization(expected);
    assert.deepEqual(validatedDownloadAuthorization(signed, tag, asset, expected), signed);
  }
  for (const base of ['https://downloads.melodyoblivion.xyz', 'https://evil.example',
    'https://www.melodyoblivion.xyz', 'https://verified-downloads.melodyoblivion.xyz:8443',
    `${websiteCdnConfig.baseUrl}?value=1`, `${websiteCdnConfig.baseUrl}#hash`]) {
    assert.throws(() => validatedDownloadBaseUrl(base), { code: 'INVALID_AUTHORIZATION' });
  }
});

test('untrusted or changed configuration fails before rendering a widget', async () => {
  const { authorizeWebsiteDownload } = await modulePromise;
  for (const baseUrl of ['https://attacker.example', 'https://downloads.melodyoblivion.xyz',
    'https://www.melodyoblivion.xyz/verified-downloads']) {
    const f = fixture({ baseUrl });
    await assert.rejects(authorizeWebsiteDownload(f.options), { code: 'INVALID_AUTHORIZATION' });
    assert.equal(f.callbacks(), undefined);
    assert.equal(f.calls.length, 1);
  }
});
