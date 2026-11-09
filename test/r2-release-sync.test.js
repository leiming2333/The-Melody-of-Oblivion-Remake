const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { targets } = require('../scripts/release-targets.cjs');

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const BUCKET = 'melody-releases';
const PUBLIC_BASE = 'https://downloads.example.test';
const TAG = 'v1.9.2';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-r2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = [];
  for (const [index, target] of targets.entries()) {
    const bytes = Buffer.from(`fixture package ${target.id}\n${index}`);
    await fs.writeFile(path.join(root, target.filename), bytes);
    assets.push({ name: target.filename, target: target.id, size: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = {
    schemaVersion: 1, tag: TAG, version: TAG.slice(1), commit: 'a'.repeat(40),
    lockSha256: 'b'.repeat(64), toolchain: {},
    assets
  };
  await fs.writeFile(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
  const metadataPath = path.join(root, 'release.json');
  await fs.writeFile(metadataPath, JSON.stringify({
    tagName: TAG, name: 'Melody release', url: 'https://github.com/example/release', body: '', publishedAt: null
  }));
  return { root, metadataPath, manifest, assets };
}

function mockR2() {
  const objects = new Map();
  const requests = [];
  const endpointPrefix = `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}`;
  const publicPrefix = `${PUBLIC_BASE}/`;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    requests.push({ url, method, headers: options.headers || {} });
    const isPublic = url.startsWith(publicPrefix);
    const pathname = isPublic
      ? decodeURIComponent(url.slice(publicPrefix.length))
      : decodeURIComponent(url.slice(`${endpointPrefix}/`.length));
    const object = objects.get(pathname);
    if (isPublic) {
      if (!object) return new Response('missing', { status: 404 });
      return new Response(Readable.toWeb(Readable.from([object])), { status: 200 });
    }
    if (method === 'GET' || method === 'HEAD') {
      if (!object) return new Response('missing', { status: 404 });
      return method === 'HEAD' ? new Response(null, { status: 200 })
        : new Response(object, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'PUT') {
      const ifNoneMatch = Object.entries(options.headers).find(([key]) => key.toLowerCase() === 'if-none-match')?.[1];
      if (ifNoneMatch === '*' && objects.has(pathname)) return new Response('exists', { status: 412 });
      const body = options.body instanceof Uint8Array ? Buffer.from(options.body)
        : Buffer.from(await new Response(options.body).arrayBuffer());
      objects.set(pathname, body);
      return new Response(null, { status: 200 });
    }
    return new Response('method', { status: 405 });
  };
  return { objects, requests, fetchImpl };
}

function env() {
  return {
    R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: BUCKET,
    R2_ACCESS_KEY_ID: 'fixture-access-key', R2_SECRET_ACCESS_KEY: 'fixture-secret-key-123456',
    R2_PUBLIC_BASE_URL: PUBLIC_BASE
  };
}

test('R2 configuration trims pasted surrounding whitespace without relaxing URL validation', async () => {
  const { validateConfig } = await import('../scripts/sync-release-to-r2.mjs');
  const clean = env();
  const pasted = Object.fromEntries(Object.entries(clean).map(([name, value]) => [name, ` \r\n${value}\t `]));
  assert.deepEqual(validateConfig(pasted), validateConfig(clean));
  assert.equal(validateConfig({ ...clean, R2_PUBLIC_BASE_URL: ` ${PUBLIC_BASE}/\n` }).publicBase, PUBLIC_BASE);
  for (const url of [
    'http://downloads.example.test', 'https://user:password@downloads.example.test',
    `${PUBLIC_BASE}:443`, `${PUBLIC_BASE}/releases`, `${PUBLIC_BASE}?query=1`,
    `${PUBLIC_BASE}#fragment`, 'https://downloads.example.test /'
  ]) {
    assert.equal(validateConfig({ ...clean, R2_PUBLIC_BASE_URL: ` ${url}\n` }), null);
  }
});

test('invalid R2 configuration reports only field names before touching files or the network', async () => {
  const { syncReleaseToR2 } = await import('../scripts/sync-release-to-r2.mjs');
  for (const field of Object.keys(env())) {
    const value = 'private invalid value';
    await assert.rejects(syncReleaseToR2('missing', TAG, 'missing.json', {
      env: { ...env(), [field]: field === 'R2_SECRET_ACCESS_KEY' ? 'secret' : value },
      fetchImpl: () => { assert.fail('Invalid configuration must not make network requests'); }
    }), error => {
      assert.match(error.message, new RegExp(`Invalid R2 configuration fields: ${field}\\.`));
      assert.ok(!error.message.includes(value));
      assert.ok(!error.message.includes('secret'));
      return true;
    });
  }
});

test('R2 synchronization uploads and verifies all eight packages before publishing latest', async t => {
  const fixtureData = await fixture(t);
  const r2 = mockR2();
  const { syncReleaseToR2 } = await import('../scripts/sync-release-to-r2.mjs');
  const result = await syncReleaseToR2(fixtureData.root, TAG, fixtureData.metadataPath, {
    env: env(), fetchImpl: r2.fetchImpl, now: () => new Date('2026-11-09T00:00:00.000Z')
  });

  assert.equal(result.assets.length, targets.length);
  assert.equal(result.latestUpdated, true);
  assert.equal(r2.objects.has(`releases/${TAG}/manifest.json`), true);
  assert.equal(r2.objects.has('releases/latest.json'), true);
  for (const item of fixtureData.assets) {
    assert.equal(r2.objects.has(`releases/${TAG}/${item.name}`), true);
  }
  const latest = JSON.parse(r2.objects.get('releases/latest.json'));
  assert.deepEqual(latest.assets.map(asset => asset.name).sort(), targets.map(target => target.filename).sort());
  assert.ok(latest.assets.every(asset => asset.object_storage_verified === true));
  assert.ok(r2.requests.filter(request => request.method === 'PUT').every(request => request.headers.Authorization?.startsWith('AWS4-HMAC-SHA256 ')));
  assert.ok(r2.requests.filter(request => request.url.startsWith(`https://${ACCOUNT}`)).every(request =>
    request.headers['x-amz-date'] && request.headers['x-amz-content-sha256']));
});

test('R2 synchronization refuses a changed immutable object without overwriting it', async t => {
  const fixtureData = await fixture(t);
  const r2 = mockR2();
  const immutablePath = `releases/${TAG}/${targets[0].filename}`;
  const original = Buffer.from('published bytes from another run');
  r2.objects.set(immutablePath, original);
  const { syncReleaseToR2 } = await import('../scripts/sync-release-to-r2.mjs');
  await assert.rejects(syncReleaseToR2(fixtureData.root, TAG, fixtureData.metadataPath, {
    env: env(), fetchImpl: r2.fetchImpl, now: () => new Date('2026-11-09T00:00:00.000Z')
  }), /digest mismatch/);
  assert.deepEqual(r2.objects.get(immutablePath), original);
  assert.equal(r2.objects.has('releases/latest.json'), false);
});

