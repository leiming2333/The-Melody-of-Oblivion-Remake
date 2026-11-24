const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { UpdateManager } = require('../src/main/updater/update-manager');
const { signAsset, keyFingerprint } = require('../src/main/updater/release-signature');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const assetName = 'Launcher-Linux-x64.AppImage';
const patchName = 'patch-v1.0.0-to-v2.0.0-linux-x64.patch';
const tag = 'v2.0.0';

function deltaBytes(bytes) {
  const integer = number => { const result = Buffer.alloc(8); result.writeBigUInt64LE(BigInt(number)); return result; };
  const control = Buffer.concat([integer(0), integer(bytes.length), integer(0)]);
  const compressed = [control, Buffer.alloc(0), bytes].map(value => zlib.zstdCompressSync(value));
  return Buffer.concat([Buffer.from('TRDIFF10'), integer(compressed[0].length), integer(compressed[1].length),
    integer(bytes.length), ...compressed]);
}

async function fixture(t, { delta = false, trust = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-signatures-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'current.AppImage');
  const old = Buffer.from('old trusted executable');
  const next = Buffer.from('new official executable');
  await fs.writeFile(target, old);
  const pair = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const trustedKeys = [{ keyId: keyFingerprint(pair.publicKey), publicKey: pair.publicKey }];
  const contents = new Map([[assetName, next]]);
  if (delta) {
    const patch = deltaBytes(next);
    contents.set(patchName, patch);
    contents.set('patch-manifest.json', Buffer.from(JSON.stringify({ schemaVersion: 1, from: 'v1.0.0', to: tag,
      patches: [{ name: patchName, target: 'linux-x64', asset: assetName, fromSha256: digest(old),
        toSha256: digest(next), toSize: next.length, size: patch.length, sha256: digest(patch) }] })));
  }
  const release = { tag_name: tag, assets: [] };
  const signatures = new Map();
  for (const [name, bytes] of contents) {
    const url = `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${tag}/${name}`;
    release.assets.push({ name, size: bytes.length, digest: `sha256:${digest(bytes)}`, browser_download_url: url });
    const text = JSON.stringify(signAsset({ tag, name, size: bytes.length, sha256: digest(bytes) }, pair.privateKey));
    signatures.set(`${name}.sig`, text);
    release.assets.push({ name: `${name}.sig`, size: Buffer.byteLength(text), digest: `sha256:${digest(text)}`, browser_download_url: `${url}.sig` });
  }
  const calls = { downloads: [], fetches: [], quit: 0 };
  function makeManager() {
    return new UpdateManager({
      app: { isPackaged: true, getVersion: () => '1.0.0', getPath: name => path.join(directory, name),
        quit: () => calls.quit++, relaunch() {} },
      platform: 'linux', arch: 'x64', env: { APPIMAGE: target }, installationTarget: target,
      trustedKeys: trust ? trustedKeys : [], rankCandidates: null,
      fetchImpl: async url => {
        calls.fetches.push(url);
        if (url.includes('/api/latest-release') || url.includes('/releases/latest')) return Response.json(release);
        const name = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
        if (signatures.has(name)) return new Response(signatures.get(name));
        if (contents.has(name)) return new Response(contents.get(name));
        return new Response('missing', { status: 404 });
      },
      downloadFile: async (url, destination, progress) => {
        calls.downloads.push(url);
        await fs.writeFile(destination, url.includes('.patch') ? contents.get(patchName) : contents.get(assetName));
        progress?.(100);
      }
    });
  }
  return { directory, target, old, next, trustedKeys, contents, release, signatures, calls, makeManager, manager: makeManager() };
}

test('signed full updates use the embedded key even when same-origin release digests are replaced', async t => {
  const f = await fixture(t);
  f.release.assets[0].digest = `sha256:${'f'.repeat(64)}`;
  assert.equal((await f.manager.check()).status, 'downloaded');
  assert.equal(await fs.readFile(f.target, 'utf8'), f.old.toString());
  assert.equal(f.manager.transaction.signature.sha256, digest(f.next));
  await f.manager.install();
  assert.equal(await fs.readFile(f.target, 'utf8'), f.next.toString());
  assert.equal(f.calls.quit, 1);
});

test('missing, forged and cross-release signatures prevent package download and replacement', async t => {
  for (const attack of ['missing', 'forged', 'tag', 'name', 'size']) {
    await t.test(attack, async t => {
      const f = await fixture(t);
      if (attack === 'missing') f.release.assets = f.release.assets.filter(asset => !asset.name.endsWith('.sig'));
      else {
        const value = JSON.parse(f.signatures.get(`${assetName}.sig`));
        if (attack === 'forged') value.signature = Buffer.alloc(64).toString('base64');
        if (attack === 'tag') value.tag = 'v3.0.0';
        if (attack === 'name') value.name = 'Another-Linux-x64.AppImage';
        if (attack === 'size') value.size++;
        f.signatures.set(`${assetName}.sig`, JSON.stringify(value));
      }
      assert.equal((await f.manager.check()).status, 'error');
      assert.equal(f.calls.downloads.length, 0);
      assert.equal(await fs.readFile(f.target, 'utf8'), f.old.toString());
    });
  }
});

test('a replaced package and matching untrusted hash cannot override the signed digest', async t => {
  const f = await fixture(t);
  const malicious = Buffer.alloc(f.next.length, 0x41);
  f.contents.set(assetName, malicious);
  f.release.assets[0].digest = `sha256:${digest(malicious)}`;
  assert.equal((await f.manager.check()).status, 'error');
  assert.equal(f.manager.transaction, null);
  assert.equal(await fs.readFile(f.target, 'utf8'), f.old.toString());
});

test('signed update evidence survives a restart and permits offline installation', async t => {
  const f = await fixture(t);
  assert.equal((await f.manager.check()).status, 'downloaded');
  const restored = f.makeManager();
  restored.fetchImpl = async () => { throw new Error('offline'); };
  assert.equal((await restored.initialize()).status, 'downloaded');
  await restored.install();
  assert.equal(await fs.readFile(f.target, 'utf8'), f.next.toString());
});

test('recovery rejects a modified package even when its unsigned journal hash is changed too', async t => {
  const f = await fixture(t);
  await f.manager.check();
  const record = f.manager.transaction;
  const malicious = Buffer.alloc(f.next.length, 0x41);
  await fs.writeFile(record.sourcePath, malicious);
  record.sha256 = digest(malicious);
  record.signature.sha256 = digest(malicious);
  await f.manager.store.save(record);
  const restored = f.makeManager();
  await restored.initialize();
  assert.equal((await restored.install()).errorCode, 'UPDATE_SIGNATURE_INVALID');
  assert.equal(await fs.readFile(f.target, 'utf8'), f.old.toString());
});

test('signed delta updates verify the manifest, patch and final executable', async t => {
  const f = await fixture(t, { delta: true });
  assert.equal((await f.manager.check()).status, 'downloaded');
  assert.equal(f.calls.downloads.length, 1);
  assert.ok(f.calls.downloads[0].includes('.patch'));
  await f.manager.install();
  assert.equal(await fs.readFile(f.target, 'utf8'), f.next.toString());
});

test('a forged delta manifest safely falls back to a separately signed full package', async t => {
  const f = await fixture(t, { delta: true });
  f.signatures.set('patch-manifest.json.sig', '{}');
  assert.equal((await f.manager.check()).status, 'downloaded');
  assert.ok(f.calls.downloads.every(url => !url.includes('.patch')));
});

test('missing or forged patch signatures fall back to the separately signed full package', async t => {
  for (const attack of ['missing', 'forged']) {
    await t.test(attack, async t => {
      const f = await fixture(t, { delta: true });
      if (attack === 'missing') f.release.assets = f.release.assets.filter(asset => asset.name !== `${patchName}.sig`);
      else f.signatures.set(`${patchName}.sig`, '{}');
      assert.equal((await f.manager.check()).status, 'downloaded');
      assert.ok(f.calls.downloads.length > 0);
      assert.ok(f.calls.downloads.every(url => !url.includes('.patch')));
      assert.deepEqual(await fs.readFile(f.manager.updateFilePath), f.next);
      await f.manager.install();
      assert.deepEqual(await fs.readFile(f.target), f.next);
    });
  }
});

test('verified R2 signature sidecars keep signed updates available when GitHub signature downloads fail', async t => {
  const f = await fixture(t);
  const signature = f.release.assets.find(asset => asset.name.endsWith('.sig'));
  signature.object_storage_download_url = `https://downloads.melodyoblivion.xyz/releases/${tag}/${signature.name}`;
  signature.object_storage_verified = true;
  const fetchImpl = f.manager.fetchImpl;
  f.manager.fetchImpl = async url => {
    if (url.includes('.sig') && !url.startsWith('https://downloads.melodyoblivion.xyz/')) throw new Error('GitHub unavailable');
    return fetchImpl(url);
  };
  assert.equal((await f.manager.check()).status, 'downloaded');
  assert.ok(f.calls.fetches.includes(signature.object_storage_download_url));
});
