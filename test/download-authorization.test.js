const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createDownloadAuthorizationHandler, readDownloadConfig, signDownload } = require('../api/download-authorization');
const { createDownloadConfigHandler } = require('../api/download-config');

const ASSET = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';
const ENV = {
  TURNSTILE_SITE_KEY: '0x4AAAAAAASiteKeyForUnitTests',
  TURNSTILE_SECRET_KEY: '0x4AAAAAAASecretKeyForUnitTests',
  DOWNLOAD_ALLOWED_HOSTNAMES: 'www.melodyoblivion.xyz,melodyoblivion.xyz',
  DOWNLOAD_AUTH_SECRET: 'test-download-secret-at-least-32-bytes',
  DOWNLOAD_CDN_BASE_URL: 'https://downloads.melodyoblivion.xyz'
};
const NOW = new Date('2026-11-02T10:00:00.000Z');

function response() {
  return {
    code: null, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(body = {}, headers = {}) {
  return {
    method: 'POST',
    headers: { origin: 'https://www.melodyoblivion.xyz', 'content-type': 'application/json', ...headers },
    body: { tag: 'v1.9.1', asset: ASSET, turnstileToken: 'a-valid-one-time-token', ...body }
  };
}

function handler(verification = { success: true, hostname: 'www.melodyoblivion.xyz', action: 'download' }, options = {}) {
  return createDownloadAuthorizationHandler({
    env: ENV, now: () => NOW,
    fetchImpl: async () => ({ ok: true, json: async () => verification }), ...options
  });
}

test('a verified browser gets a short-lived Worker permit, without proxying bytes', async () => {
  const calls = [];
  const authorize = handler(undefined, { fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('secret'), ENV.TURNSTILE_SECRET_KEY);
    assert.equal(init.body.get('response'), 'a-valid-one-time-token');
    assert.ok(init.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ success: true, hostname: 'www.melodyoblivion.xyz', action: 'download' }) };
  } });
  const res = response();
  await authorize(request(), res);
  assert.equal(res.code, 200);
  assert.equal(calls.length, 1, 'the authorization server must not fetch or stream the installer');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body.expiresAt, '2026-11-02T10:15:00.000Z');
  const url = new URL(res.body.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'downloads.melodyoblivion.xyz');
  assert.equal(url.pathname, `/releases/v1.9.1/${ASSET}`);
  assert.deepEqual([...url.searchParams.keys()], ['expires', 'signature']);
  assert.equal(Number(url.searchParams.get('expires')), Math.floor(NOW.getTime() / 1000) + 900);
  assert.match(url.searchParams.get('signature'), /^[A-Za-z\d_-]{43}$/);
  assert.ok(!JSON.stringify(res.body).includes(ENV.DOWNLOAD_AUTH_SECRET));
  assert.ok(!JSON.stringify(res.body).includes(ENV.TURNSTILE_SECRET_KEY));
});

test('authorization is denied for failed, expired, absent, forged, or mismatched verification', async () => {
  for (const verification of [
    undefined, null, { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: 'true', hostname: 'www.melodyoblivion.xyz', action: 'download' },
    { success: true, hostname: 'www.melodyoblivion.xyz.attacker.example', action: 'download' },
    { success: true, hostname: 'www.melodyoblivion.xyz', action: 'login' },
    { success: true, hostname: 'www.melodyoblivion.xyz' }
  ]) {
    const res = response();
    await handler(verification, { fetchImpl: async () => ({ ok: true, json: async () => verification }) })(request(), res);
    assert.equal(res.code, 403);
    assert.equal(res.body.code, 'VERIFICATION_FAILED');
    assert.equal(res.body.url, undefined);
  }
});

test('verification outages and invalid responses never issue a URL', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('timeout with private details'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('not json'); } })
  ]) {
    const res = response();
    await handler(undefined, { fetchImpl })(request(), res);
    assert.equal(res.code, 502);
    assert.equal(res.body.code, 'VERIFICATION_UNAVAILABLE');
    assert.equal(res.body.url, undefined);
    assert.ok(!JSON.stringify(res.body).includes('private details'));
  }
});

test('invalid methods, origins, assets, paths, and bodies do not even consume a Turnstile token', async () => {
  const authorize = handler(undefined, { fetchImpl: async () => { throw new Error('should not verify malformed request'); } });
  const cases = [
    [{ ...request(), method: 'GET' }, 405],
    [request({}, { origin: 'https://www.melodyoblivion.xyz.attacker.example' }), 403],
    [request({}, { origin: 'http://www.melodyoblivion.xyz' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz:8443' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz/' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz/path' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz?query=1' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz#fragment' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz:443' }), 403],
    [request({}, { origin: ['https://www.melodyoblivion.xyz'] }), 403],
    [request({}, { origin: undefined }), 403],
    [request({ asset: '../private.json' }), 400],
    [request({ asset: `${ASSET}?download=1` }), 400],
    [request({ asset: `${ASSET}.sha256` }), 400],
    [request({ tag: 'v1.9.1/../../secret' }), 400],
    [request({ tag: 'latest' }), 400],
    [request({ turnstileToken: '' }), 400],
    [request({ turnstileToken: 'a'.repeat(2049) }), 400],
    [request({ url: 'https://attacker.example/installer' }), 400],
    [request({}, { 'content-type': 'text/plain' }), 400],
    [{ ...request(), body: '{broken json' }, 400],
    [{ ...request(), body: JSON.stringify(request().body) }, 200]
  ];
  // The parsed and raw JSON paths have the same validation; use a successful verifier for the final case.
  for (const [req, expected] of cases) {
    const res = response();
    await (expected === 200 ? handler() : authorize)(req, res);
    assert.equal(res.code, expected);
    if (expected !== 200) assert.equal(res.body.url, undefined);
  }
});

test('configuration fails closed for missing credentials, unsafe endpoints, expiry, and Cloudflare test keys', async () => {
  for (const env of [
    {}, { ...ENV, DOWNLOAD_AUTH_SECRET: '' }, { ...ENV, DOWNLOAD_AUTH_SECRET: 'a'.repeat(31) },
    { ...ENV, DOWNLOAD_AUTH_SECRET: 'a'.repeat(4097) }, { ...ENV, DOWNLOAD_ALLOWED_HOSTNAMES: '' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'http://downloads.melodyoblivion.xyz' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://downloads.melodyoblivion.xyz/prefix' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://user:pass@downloads.melodyoblivion.xyz' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://downloads.melodyoblivion.xyz?url=https://attacker.example' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://downloads.melodyoblivion.xyz#fragment' },
    { ...ENV, DOWNLOAD_ALLOWED_HOSTNAMES: '*.example.com' }, { ...ENV, DOWNLOAD_URL_TTL_SECONDS: '3601' },
    { ...ENV, DOWNLOAD_URL_TTL_SECONDS: '0' },
    { ...ENV, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
    { ...ENV, TURNSTILE_SITE_KEY: '2x00000000000000000000AB' },
    { ...ENV, TURNSTILE_SITE_KEY: '3x00000000000000000000FF' },
    { ...ENV, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' },
    { ...ENV, TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' },
    { ...ENV, TURNSTILE_SECRET_KEY: '3x0000000000000000000000000000000AA' },
    { ...ENV, TURNSTILE_SECRET_KEY: '9x0000000000000000000000000000000AA' }
  ]) {
    const res = response();
    await handler(undefined, { env })(request(), res);
    assert.equal(res.code, 503);
    assert.equal(res.body.code, 'DOWNLOAD_NOT_CONFIGURED');
  }
});

test('the public configuration contains only a public site key and action and never advertises a partial gate', () => {
  for (const [env, expected] of [[ENV, { enabled: true, siteKey: ENV.TURNSTILE_SITE_KEY, action: 'download' }],
    [{ ...ENV, DOWNLOAD_AUTH_SECRET: '' }, { enabled: false, siteKey: null, action: 'download' }]]) {
    const res = response();
    createDownloadConfigHandler({ env })({ method: 'GET' }, res);
    assert.equal(res.code, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body, expected);
  }
  const invalid = response();
  createDownloadConfigHandler({ env: ENV })({ method: 'POST' }, invalid);
  assert.equal(invalid.code, 405);
});

test('another CDN hostname disables the gate before verification instead of issuing an unusable permit', async () => {
  for (const baseUrl of ['https://melody-downloads.leiming2333.workers.dev', 'https://new-downloads.example.com',
    'https://downloads.melodyoblivion.xyz.attacker.example']) {
    const env = { ...ENV, DOWNLOAD_CDN_BASE_URL: baseUrl };
    const configResponse = response();
    createDownloadConfigHandler({ env })({ method: 'GET' }, configResponse);
    assert.deepEqual(configResponse.body, { enabled: false, siteKey: null, action: 'download' });
    let verifications = 0;
    const denied = response();
    await handler(undefined, { env, fetchImpl: async () => { verifications++; throw new Error('must not verify'); } })(request(), denied);
    assert.equal(denied.code, 503);
    assert.equal(denied.body.code, 'DOWNLOAD_NOT_CONFIGURED');
    assert.equal(denied.body.url, undefined);
    assert.equal(verifications, 0);
  }
});

test('the signature and expiry bind the exact asset, date and TTL', async () => {
  const config = readDownloadConfig(ENV);
  const first = new URL(signDownload(config, 'v1.9.1', ASSET, NOW).url);
  const another = new URL(signDownload(config, 'v1.9.2', ASSET, NOW).url);
  const later = new URL(signDownload(config, 'v1.9.1', ASSET, new Date(NOW.getTime() + 1000)).url);
  const longer = signDownload({ ...config, ttl: 3600 }, 'v1.9.1', ASSET, NOW);
  assert.notEqual(first.searchParams.get('signature'), another.searchParams.get('signature'));
  assert.notEqual(first.searchParams.get('signature'), later.searchParams.get('signature'));
  assert.notEqual(first.searchParams.get('signature'), new URL(longer.url).searchParams.get('signature'));
  assert.equal(longer.expiresAt, '2026-11-02T11:00:00.000Z');
  // Use a separate crypto implementation to verify the API's Node HMAC contract.
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(ENV.DOWNLOAD_AUTH_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Buffer.from(first.searchParams.get('signature'), 'base64url');
  assert.equal(await webcrypto.subtle.verify('HMAC', key, signature,
    new TextEncoder().encode(`download-v1\n${first.pathname}\n${first.searchParams.get('expires')}`)), true);
});

test('the API always checks the single-use Turnstile token again on a repeated authorization', async () => {
  let calls = 0;
  const authorize = handler(undefined, { fetchImpl: async () => {
    calls++;
    return { ok: true, json: async () => calls === 1
      ? { success: true, hostname: 'www.melodyoblivion.xyz', action: 'download' }
      : { success: false, 'error-codes': ['timeout-or-duplicate'] } };
  } });
  const first = response();
  const replay = response();
  await authorize(request(), first);
  await authorize(request(), replay);
  assert.equal(first.code, 200);
  assert.equal(replay.code, 403);
  assert.equal(replay.body.url, undefined);
  assert.equal(calls, 2);
});

test('the shared CDN default and exact UTF-8 secret bytes agree with the Worker', async () => {
  const env = { ...ENV, DOWNLOAD_AUTH_SECRET: ` ${'密'.repeat(12)} ` };
  delete env.DOWNLOAD_CDN_BASE_URL;
  const config = readDownloadConfig(env);
  assert.equal(config.baseUrl, require('../src/shared/website-cdn-config.json').baseUrl);
  assert.equal(config.authSecret, env.DOWNLOAD_AUTH_SECRET);
  const { createDownloadWorker } = await import('../cloudflare/download-worker.mjs');
  let fetches = 0;
  const worker = createDownloadWorker({ cache: null, fetchImpl: async () => {
    fetches++;
    return new Response('file', { headers: { 'Content-Length': '4', 'Content-Type': 'application/octet-stream' } });
  } });
  const permit = signDownload(config, 'v1.9.1', ASSET);
  const valid = await worker.fetch(new Request(permit.url), { DOWNLOAD_AUTH_SECRET: env.DOWNLOAD_AUTH_SECRET });
  assert.equal(valid.status, 200);
  assert.equal(await valid.text(), 'file');
  assert.equal(fetches, 1);
  for (const url of [permit.url.replace('/v1.9.1/', '/v1.9.2/'),
    `${permit.url}&expires=9999999999`, `${permit.url}&signature=bad`,
    permit.url.replace(/expires=\d+/, 'expires=1000000000')]) {
    const denied = await worker.fetch(new Request(url), { DOWNLOAD_AUTH_SECRET: env.DOWNLOAD_AUTH_SECRET });
    assert.equal(denied.status, 403);
    assert.equal(fetches, 1, 'a tampered permit must not read cache or origin');
  }
});
