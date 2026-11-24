const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { targets } = require('../scripts/release-targets.cjs');
const { signDirectory } = require('../scripts/sign-release.cjs');
const { keyFingerprint } = require('../src/main/updater/release-signature');
const { UpdateManager } = require('../src/main/updater/update-manager');

const tag = 'v2.1.2';
const publicBase = 'https://downloads.melodyoblivion.xyz';
const blobBase = 'https://fixture.public.blob.vercel-storage.com';
const accountId = 'a'.repeat(32);
const env = { R2_ACCOUNT_ID: accountId, R2_BUCKET_NAME: 'release-fixtures',
  R2_ACCESS_KEY_ID: 'fixture-access-key', R2_SECRET_ACCESS_KEY: 'fixture-secret-key-with-length',
  R2_PUBLIC_BASE_URL: publicBase };
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-signed-mirror-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const assets = [];
  for (const target of targets) {
    const bytes = Buffer.from(`signed package ${target.id}`);
    await fs.writeFile(path.join(directory, target.filename), bytes);
    await fs.writeFile(path.join(directory, `${target.filename}.sha256`), `${digest(bytes)}  ${target.filename}\n`);
    assets.push({ name: target.filename, target: target.id, size: bytes.length, sha256: digest(bytes) });
  }
  const manifest = { schemaVersion: 1, tag, version: tag.slice(1), assets };
  await fs.writeFile(path.join(directory, 'release-manifest.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(directory, 'SHA256SUMS'), assets.map(item => `${item.sha256}  ${item.name}\n`).join(''));
  const patchBytes = Buffer.from('signed fixture delta');
  const patch = { target: targets[0].id, asset: assets[0].name,
    fromSha256: 'b'.repeat(64), toSha256: assets[0].sha256, toSize: assets[0].size,
    name: `patch-v2.1.1-to-${tag}-windows-x64.patch`, size: patchBytes.length, sha256: digest(patchBytes) };
  await fs.writeFile(path.join(directory, patch.name), patchBytes);
  const patchManifest = JSON.stringify({ schemaVersion: 1, from: 'v2.1.1', to: tag, patches: [patch] });
  await fs.writeFile(path.join(directory, 'patch-manifest.json'), patchManifest);
  await fs.writeFile(path.join(directory, 'patch-manifest.json.sha256'), `${digest(patchManifest)}  patch-manifest.json\n`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const trustedKeys = [{ keyId: keyFingerprint(publicKey), publicKey }];
  await signDirectory(directory, { tag, privateKey, keys: trustedKeys });
  const metadataPath = path.join(directory, 'release.json');
  await fs.writeFile(metadataPath, JSON.stringify({ tagName: tag }));
  return { directory, metadataPath, trustedKeys, assets, patch };
}

function mockMirror(provider) {
  const objects = new Map();
  const writes = [];
  const requests = [];
  const origin = `https://${accountId}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/`;
  const base = provider === 'r2' ? publicBase : blobBase;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    requests.push({ url, method });
    const prefix = url.startsWith(origin) ? origin : `${base}/`;
    assert.ok(url.startsWith(prefix), 'fixture never fetches GitHub');
    const name = decodeURIComponent(url.slice(prefix.length));
    const current = objects.get(name);
    if (method === 'PUT') {
      if (options.headers['if-none-match'] === '*' && current) return new Response(null, { status: 412 });
      writes.push(name);
      objects.set(name, Buffer.from(options.body));
      return new Response(null, { status: 200 });
    }
    return new Response(method === 'HEAD' ? null : current, {
      status: current ? 200 : 404, headers: current ? { etag: `"${digest(current)}"` } : {}
    });
  };
  const options = provider === 'r2' ? { env, fetchImpl } : {
    token: 'fixture-token',
    listBlobs: async ({ prefix }) => ({ blobs: [...objects.keys()].filter(name => name.startsWith(prefix))
      .map(pathname => ({ pathname, url: `${base}/${pathname}` })) }),
    putBlob: async (name, bytes, options) => {
      if (name !== 'releases/latest.json') {
        assert.equal(options.allowOverwrite, false);
        assert.equal(objects.has(name), false);
      }
      writes.push(name);
      objects.set(name, Buffer.from(bytes));
      return { url: `${base}/${name}` };
    },
    fetchUrl: fetchImpl
  };
  return { objects, writes, requests, fetchImpl, options };
}

async function sync(provider, f, mirror, overrides = {}) {
  const options = { ...mirror.options, trustedKeys: f.trustedKeys, ...overrides };
  if (provider === 'r2') {
    const { syncReleaseToR2 } = await import('../scripts/sync-release-to-r2.mjs');
    return syncReleaseToR2(f.directory, tag, f.metadataPath, options);
  }
  const { syncRelease } = await import('../scripts/sync-release-to-blob.mjs');
  return syncRelease(f.directory, tag, f.metadataPath, options);
}

for (const provider of ['r2', 'blob']) {
  test(`${provider} exposes verified signatures and patches before latest, enabling offline GitHub verification`, async t => {
    const f = await fixture(t);
    const mirror = mockMirror(provider);
    const release = await sync(provider, f, mirror);
    assert.equal(release.latestUpdated, true);
    assert.equal(mirror.writes.at(-1), 'releases/latest.json');
    const localSignatures = (await fs.readdir(f.directory)).filter(name => name.endsWith('.sig'));
    for (const name of localSignatures) {
      assert.deepEqual(mirror.objects.get(`releases/${tag}/${name}`), await fs.readFile(path.join(f.directory, name)));
      const asset = release.assets.find(item => item.name === name);
      assert.ok(asset?.browser_download_url);
      assert.equal(asset.digest, `sha256:${digest(mirror.objects.get(`releases/${tag}/${name}`))}`);
    }
    assert.equal(release.assets.filter(item => /\.(exe|zip|AppImage)$/.test(item.name)).length, 8);
    const manager = new UpdateManager({ trustedKeys: f.trustedKeys, fetchImpl: mirror.fetchImpl });
    manager.release = release;
    for (const name of [f.assets[0].name, 'patch-manifest.json', f.patch.name]) {
      const asset = release.assets.find(item => item.name === name);
      assert.ok(asset, name);
      assert.equal(await manager.expectedSha256For(asset), digest(await fs.readFile(path.join(f.directory, name))));
    }
    const writesBeforeRetry = mirror.writes.length;
    await sync(provider, f, mirror);
    assert.deepEqual(mirror.writes.slice(writesBeforeRetry), ['releases/latest.json']);
  });

  test(`${provider} rejects missing or tampered local signatures before any mirror request`, async t => {
    const f = await fixture(t);
    const mirror = mockMirror(provider);
    const signaturePath = path.join(f.directory, `${f.assets[0].name}.sig`);
    const original = await fs.readFile(signaturePath);
    await fs.rm(signaturePath);
    await assert.rejects(sync(provider, f, mirror), /Missing release signature/);
    assert.equal(mirror.requests.length, 0);
    assert.equal(mirror.writes.length, 0);
    const tampered = JSON.parse(original);
    tampered.sha256 = 'f'.repeat(64);
    await fs.writeFile(signaturePath, JSON.stringify(tampered));
    await assert.rejects(sync(provider, f, mirror), /签名/);
    assert.equal(mirror.requests.length, 0);
    assert.equal(mirror.writes.length, 0);
    await fs.writeFile(signaturePath, original);
    await assert.rejects(sync(provider, f, mirror, { trustedKeys: [] }), /不受信任/);
    assert.equal(mirror.writes.length, 0);
  });

  test(`${provider} refuses a changed published signature without replacing it or latest`, async t => {
    const f = await fixture(t);
    const mirror = mockMirror(provider);
    const name = `releases/${tag}/${f.assets[0].name}.sig`;
    mirror.objects.set(name, Buffer.from('changed published signature'));
    await assert.rejects(sync(provider, f, mirror), /digest mismatch|immutable or unavailable/);
    assert.deepEqual(mirror.objects.get(name), Buffer.from('changed published signature'));
    assert.equal(mirror.objects.has('releases/latest.json'), false);
    assert.ok(!mirror.writes.includes(name));
  });

  test(`${provider} leaves latest unpublished if public signature readback is corrupted`, async t => {
    const f = await fixture(t);
    const mirror = mockMirror(provider);
    const fetchCorrupted = async (url, options = {}) => {
      if (url.endsWith('.sig') && !url.includes('.r2.cloudflarestorage.com/')) {
        return new Response('corrupted public signature');
      }
      return mirror.fetchImpl(url, options);
    };
    await assert.rejects(sync(provider, f, mirror, provider === 'r2'
      ? { fetchImpl: fetchCorrupted } : { fetchUrl: fetchCorrupted }), /digest mismatch/);
    assert.equal(mirror.objects.has('releases/latest.json'), false);
  });
}
