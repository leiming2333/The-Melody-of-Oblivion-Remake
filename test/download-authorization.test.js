const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const websiteCdnConfig = require('../src/shared/website-cdn-config.json');

const {
  createDownloadAuthorizationHandler,
  parseBody
} = require('../api/download-authorization');
const defaultAuthorizationHandler = require('../api/download-authorization');
const {
  createDownloadConfigHandler,
  publicDownloadConfig,
  readDownloadConfig
} = require('../api/download-config');

const ASSETS = [
  'The-Melody-of-Oblivion-Remake-Windows-x64.exe',
  'The-Melody-of-Oblivion-Remake-Windows-ia32.exe',
  'The-Melody-of-Oblivion-Remake-Windows-arm64.exe',
  'The-Melody-of-Oblivion-Remake-Linux-x64.AppImage',
  'The-Melody-of-Oblivion-Remake-Linux-arm64.AppImage',
  'The-Melody-of-Oblivion-Remake-Linux-armv7l.AppImage',
  'The-Melody-of-Oblivion-Remake-macOS-x64.zip',
  'The-Melody-of-Oblivion-Remake-macOS-arm64.zip'
];
const ASSET = ASSETS[0];
const NOW = new Date('2026-11-10T08:00:00.000Z');
const ENV = {
  TURNSTILE_SITE_KEY: 'fixture-production-site-key',
  TURNSTILE_SECRET_KEY: 'fixture-production-secret-key',
  DOWNLOAD_AUTH_SECRET: 'fixture-authorization-secret-at-least-thirty-two-bytes',
  DOWNLOAD_CDN_BASE_URL: websiteCdnConfig.baseUrl,
  DOWNLOAD_ALLOWED_HOSTNAMES: 'www.melodyoblivion.xyz,melodyoblivion.xyz',
  DOWNLOAD_URL_TTL_SECONDS: '900'
};

function response() {
  return {
    code: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(body = {}, headers = {}) {
  return {
    method: 'POST',
    headers: { origin: 'https://www.melodyoblivion.xyz', 'content-type': 'application/json', ...headers },
    body: { tag: 'v1.9.3', asset: ASSET, turnstileToken: 'fixture-turnstile-token', ...body }
  };
}

function verificationResponse(value) {
  const result = arguments.length === 0
    ? { success: true, hostname: 'www.melodyoblivion.xyz', action: 'download' }
    : value;
  return { ok: true, json: async () => result };
}

function handler(options = {}) {
  return createDownloadAuthorizationHandler({
    env: ENV,
    now: () => NOW,
    fetchImpl: async () => verificationResponse(),
    ...options
  });
}

function expectedAuthorization(asset = ASSET, env = ENV) {
  const pathname = new URL(`${env.DOWNLOAD_CDN_BASE_URL}/releases/v1.9.3/${asset}`).pathname;
  const expires = Math.floor(NOW.getTime() / 1000) + Number(env.DOWNLOAD_URL_TTL_SECONDS);
  const signature = createHmac('sha256', env.DOWNLOAD_AUTH_SECRET)
    .update(`download-v1\n${pathname}\n${expires}`).digest('base64url');
  return { url: `${env.DOWNLOAD_CDN_BASE_URL}/releases/v1.9.3/${asset}?expires=${expires}&signature=${signature}`,
    expiresAt: new Date(expires * 1000).toISOString() };
}

test('a verified browser gets a path-bound signed Worker URL and no credential data', async () => {
  const calls = [];
  const authorize = handler({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(init.body.get('secret'), ENV.TURNSTILE_SECRET_KEY);
    assert.equal(init.body.get('response'), 'fixture-turnstile-token');
    assert.ok(init.signal instanceof AbortSignal);
    return verificationResponse();
  } });
  const result = response();
  await authorize(request(), result);

  assert.equal(result.code, 200);
  assert.deepEqual(result.body, expectedAuthorization());
  assert.equal(calls.length, 1);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.doesNotMatch(JSON.stringify(result.body), /fixture-production-secret-key/);
  assert.ok(!JSON.stringify(result.body).includes(ENV.DOWNLOAD_AUTH_SECRET));
});

test('all eight published asset names can be authorized after one valid verification shape', async () => {
  for (const asset of ASSETS) {
    const result = response();
    await handler()(request({ asset }), result);
    assert.equal(result.code, 200);
    assert.deepEqual(result.body, expectedAuthorization(asset));
  }
});

test('failed, mismatched, or incomplete Turnstile results never issue a download permit', async () => {
  const results = [
    undefined,
    null,
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: 'true', hostname: 'www.melodyoblivion.xyz', action: 'download' },
    { success: true, hostname: 'attacker.example', action: 'download' },
    { success: true, hostname: 'www.melodyoblivion.xyz', action: 'login' },
    { success: true, hostname: 'www.melodyoblivion.xyz' }
  ];
  for (const verification of results) {
    const result = response();
    await handler({ fetchImpl: async () => verificationResponse(verification) })(request(), result);
    assert.equal(result.code, 403);
    assert.equal(result.body.code, 'VERIFICATION_FAILED');
    assert.equal(result.body.url, undefined);
  }
});

test('verification outages return a generic error and never leak the provider response', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('private provider detail'); },
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => { throw new Error('invalid private body'); } })
  ]) {
    const result = response();
    await handler({ fetchImpl })(request(), result);
    assert.equal(result.code, 502);
    assert.equal(result.body.code, 'VERIFICATION_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result.body), /private/);
    assert.equal(result.body.url, undefined);
  }
});

test('method, origin, body, tag, and asset validation happens before Siteverify', async () => {
  let calls = 0;
  const authorize = handler({ fetchImpl: async () => {
    calls++;
    return verificationResponse();
  } });
  const cases = [
    [{ ...request(), method: 'GET' }, 405],
    [request({}, { origin: 'http://www.melodyoblivion.xyz' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz.attacker.example' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz:8443' }), 403],
    [request({}, { origin: 'https://www.melodyoblivion.xyz/' }), 403],
    [request({ asset: '../secret.exe' }), 400],
    [request({ asset: `${ASSET}.sha256` }), 400],
    [request({ tag: 'latest' }), 400],
    [request({ turnstileToken: '' }), 400],
    [request({ turnstileToken: 'a'.repeat(2049) }), 400],
    [request({}, { 'content-type': 'text/plain' }), 400],
    [{ ...request(), body: '{broken json' }, 400]
  ];
  for (const [input, expected] of cases) {
    const result = response();
    await authorize(input, result);
    assert.equal(result.code, expected);
    assert.equal(result.body.url, undefined);
  }
  assert.equal(calls, 0);
});

test('the parser accepts JSON text but rejects extra fields and malformed objects', () => {
  const valid = request().body;
  assert.deepEqual(parseBody(request()), valid);
  assert.deepEqual(parseBody({ ...request(), body: JSON.stringify(valid) }), valid);
  assert.equal(parseBody({ ...request(), body: { ...valid, extra: true } }), null);
  assert.equal(parseBody({ ...request(), body: [] }), null);
  assert.equal(parseBody({ ...request(), body: JSON.stringify({ ...valid, extra: true }) }), null);
});

test('configuration fails closed for missing values, unsafe hostnames, TTL, and published test keys', () => {
  for (const env of [
    {},
    { ...ENV, TURNSTILE_SITE_KEY: '' },
    { ...ENV, TURNSTILE_SECRET_KEY: '' },
    { ...ENV, DOWNLOAD_AUTH_SECRET: undefined },
    { ...ENV, DOWNLOAD_AUTH_SECRET: 'short' },
    { ...ENV, DOWNLOAD_AUTH_SECRET: 'a'.repeat(4097) },
    { ...ENV, DOWNLOAD_ALLOWED_HOSTNAMES: '' },
    { ...ENV, DOWNLOAD_ALLOWED_HOSTNAMES: '*.melodyoblivion.xyz' },
    { ...ENV, DOWNLOAD_ALLOWED_HOSTNAMES: 'www.melodyoblivion.xyz/path' },
    { ...ENV, DOWNLOAD_URL_TTL_SECONDS: '59' },
    { ...ENV, DOWNLOAD_URL_TTL_SECONDS: '3601' },
    { ...ENV, DOWNLOAD_URL_TTL_SECONDS: 'not-a-number' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://downloads.melodyoblivion.xyz' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://attacker.example' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://verified-downloads.melodyoblivion.xyz.evil.example' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'http://verified-downloads.melodyoblivion.xyz' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://user:password@verified-downloads.melodyoblivion.xyz' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://verified-downloads.melodyoblivion.xyz:8443' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: 'https://www.melodyoblivion.xyz' },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: `${ENV.DOWNLOAD_CDN_BASE_URL}?bypass=true` },
    { ...ENV, DOWNLOAD_CDN_BASE_URL: `${ENV.DOWNLOAD_CDN_BASE_URL}#fragment` },
    { ...ENV, TURNSTILE_SITE_KEY: '1x00000000000000000000AA' },
    { ...ENV, TURNSTILE_SECRET_KEY: '2x0000000000000000000000000000000AA' }
  ]) {
    assert.equal(readDownloadConfig(env), null);
    assert.deepEqual(publicDownloadConfig(env), { enabled: false, siteKey: null, action: 'download', baseUrl: null });
  }
});

test('public config exposes only the site key, action, and a pinned Worker base', () => {
  assert.deepEqual(publicDownloadConfig(ENV), {
    enabled: true, siteKey: ENV.TURNSTILE_SITE_KEY, action: 'download', baseUrl: ENV.DOWNLOAD_CDN_BASE_URL
  });
  const result = response();
  createDownloadConfigHandler({ env: ENV })({ method: 'GET' }, result);
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, publicDownloadConfig(ENV));
  assert.equal(result.headers['Cache-Control'], 'no-store');

  const invalid = response();
  createDownloadConfigHandler({ env: ENV })({ method: 'POST' }, invalid);
  assert.equal(invalid.code, 405);
  assert.equal(invalid.body.code, 'METHOD_NOT_ALLOWED');
});

test('all configured protected endpoints sign the full actual path without changing the public R2 origin', async () => {
  for (const baseUrl of websiteCdnConfig.allowedBases) {
    const env = { ...ENV, DOWNLOAD_CDN_BASE_URL: baseUrl };
    const result = response();
    await handler({ env })(request(), result);
    assert.equal(result.code, 200);
    assert.deepEqual(result.body, expectedAuthorization(ASSET, env));
    assert.equal(publicDownloadConfig(env).baseUrl, baseUrl);
    assert.equal(readDownloadConfig({ ...env, DOWNLOAD_CDN_BASE_URL: `${baseUrl}/` }).baseUrl, baseUrl);
  }
});

test('shared signing secrets use exact UTF-8 bytes instead of trimming one side', async () => {
  const env = { ...ENV, DOWNLOAD_AUTH_SECRET: `${ENV.DOWNLOAD_AUTH_SECRET} ` };
  const result = response();
  await handler({ env })(request(), result);
  assert.deepEqual(result.body, expectedAuthorization(ASSET, env));
  assert.notEqual(result.body.url, expectedAuthorization().url);
});

test('a Siteverify timeout-or-duplicate on token replay cannot issue another permit', async () => {
  let uses = 0;
  const authorize = handler({ fetchImpl: async () => uses++ === 0 ? verificationResponse()
    : verificationResponse({ success: false, 'error-codes': ['timeout-or-duplicate'] }) });
  const first = response();
  const replay = response();
  await authorize(request(), first);
  await authorize(request(), replay);
  assert.equal(first.code, 200);
  assert.equal(replay.code, 403);
  assert.equal(replay.body.url, undefined);
});

test('the default handler keeps its public API behavior when production env is unavailable', async () => {
  const result = response();
  await defaultAuthorizationHandler({ method: 'POST', headers: {}, body: {} }, result);
  assert.equal(result.code, 503);
  assert.equal(result.body.code, 'DOWNLOAD_NOT_CONFIGURED');
});
