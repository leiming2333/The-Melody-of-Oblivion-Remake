const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { targets } = require('../scripts/release-targets.cjs');
const { buildPatches, discoverPreviousReleases } = require('../scripts/build-patches.cjs');
const { checksumLines, verifyPatchManifest } = require('../scripts/release-assets.cjs');
const { verifyPublicationFiles } = require('../scripts/publish-release.cjs');

function i64(value) {
  const bytes = Buffer.alloc(8);
  let number = BigInt(value);
  for (let index = 0; index < 7; index += 1) {
    bytes[index] = Number(number & 0xffn);
    number >>= 8n;
  }
  bytes[7] |= Number(number & 0x7fn);
  return bytes;
}

function extraPatch(oldBytes, newBytes) {
  const control = Buffer.concat([i64(0), i64(newBytes.length), i64(0)]);
  const compressed = [control, Buffer.alloc(0), newBytes].map(value => zlib.zstdCompressSync(value));
  return Buffer.concat([Buffer.from('TRDIFF10'), i64(compressed[0].length), i64(compressed[1].length),
    i64(newBytes.length), ...compressed]);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-patches-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const release = path.join(root, 'release');
  const previous = path.join(root, 'previous');
  await fs.mkdir(release, { recursive: true });
  await fs.mkdir(previous, { recursive: true });
  const releaseManifest = { schemaVersion: 1, tag: 'v1.9.4', version: '1.9.4', assets: [] };
  const previousManifest = { schemaVersion: 1, tag: 'v1.9.3', version: '1.9.3', assets: [] };
  for (const target of targets) {
    const oldBytes = Buffer.from(`old-${target.id}-`.repeat(256));
    const newBytes = Buffer.from(`new-${target.id}-`.repeat(256));
    const oldFile = path.join(previous, target.filename);
    const newFile = path.join(release, target.filename);
    await fs.writeFile(oldFile, oldBytes);
    await fs.writeFile(newFile, newBytes);
    const oldSha256 = createHash('sha256').update(oldBytes).digest('hex');
    const newSha256 = createHash('sha256').update(newBytes).digest('hex');
    previousManifest.assets.push({ name: target.filename, size: oldBytes.length, sha256: oldSha256 });
    releaseManifest.assets.push({ name: target.filename, size: newBytes.length, sha256: newSha256 });
  }
  await fs.writeFile(path.join(release, 'release-manifest.json'), JSON.stringify(releaseManifest));
  await fs.writeFile(path.join(previous, 'release-manifest.json'), JSON.stringify(previousManifest));
  return { root, release, previous, releaseManifest, previousManifest };
}

function fakeRunner(writePatch = (oldBytes, newBytes) => extraPatch(oldBytes, newBytes)) {
  return async (_bin, oldFile, newFile, patchFile) => {
    await fs.writeFile(patchFile, writePatch(await fs.readFile(oldFile), await fs.readFile(newFile)));
  };
}

test('builds a verified patch per platform and binds both old and new hashes', async t => {
  const f = await fixture(t);
  const manifest = await buildPatches({
    releaseDir: f.release, previousDir: f.previous, fromTag: 'v1.9.3',
    bsdiffPath: 'bsdiff-fixture.exe', runBsdiff: fakeRunner(), log: () => {}
  });
  assert.equal(manifest.patches.length, 8);
  assert.equal((await fs.stat(path.join(f.release, 'patch-manifest.json'))).isFile(), true);
  assert.equal((await verifyPatchManifest(f.release, f.releaseManifest)).patches.length, 8);
  for (const patch of manifest.patches) {
    assert.equal(patch.fromSha256.length, 64);
    assert.equal(patch.toSha256.length, 64);
    assert.ok(patch.size > 0);
    assert.equal((await fs.stat(path.join(f.release, patch.name))).size, patch.size);
  }
  assert.deepEqual(manifest.patches.map(patch => patch.target).sort(), targets.map(target => target.id).sort());
});

test('builds sources for the latest three previous stable versions', async t => {
  const f = await fixture(t);
  const releaseManifest = JSON.parse(await fs.readFile(path.join(f.release, 'release-manifest.json'), 'utf8'));
  releaseManifest.tag = 'v1.9.7';
  releaseManifest.version = '1.9.7';
  await fs.writeFile(path.join(f.release, 'release-manifest.json'), JSON.stringify(releaseManifest));
  const previousReleases = [];
  for (const tag of ['v1.9.6', 'v1.9.5', 'v1.9.4']) {
    const directory = path.join(f.root, tag);
    await fs.mkdir(directory);
    const assets = [];
    for (const target of targets) {
      const bytes = Buffer.from(`older-${tag}-${target.id}-`.repeat(256));
      await fs.writeFile(path.join(directory, target.filename), bytes);
      assets.push({ name: target.filename, size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    await fs.writeFile(path.join(directory, 'release-manifest.json'),
      JSON.stringify({ schemaVersion: 1, tag, version: tag.slice(1), assets }));
    previousReleases.push({ tag, directory });
  }
  const manifest = await buildPatches({
    releaseDir: f.release, previousReleases,
    bsdiffPath: 'bsdiff-fixture.exe', runBsdiff: fakeRunner(), log: () => {}
  });
  assert.equal(manifest.sources.length, 3);
  assert.equal(manifest.from, 'v1.9.6');
  assert.equal(manifest.patches.length, 8);
  assert.equal(manifest.sources.reduce((sum, source) => sum + source.patches.length, 0), 24);
  assert.deepEqual(manifest.sources.map(source => source.from), ['v1.9.6', 'v1.9.5', 'v1.9.4']);
  assert.equal((await verifyPatchManifest(f.release, releaseManifest)).patches.length, 24);
  assert.deepEqual((await discoverPreviousReleases(f.root, 'v1.9.7')).map(source => source.tag),
    ['v1.9.6', 'v1.9.5', 'v1.9.4']);
});

test('drops every patch that exceeds the size budget and publishes no manifest', async t => {
  const f = await fixture(t);
  const manifest = await buildPatches({
    releaseDir: f.release, previousDir: f.previous, fromTag: 'v1.9.3',
    bsdiffPath: 'bsdiff-fixture.exe', runBsdiff: fakeRunner(), maxRatio: 0.000001, log: () => {}
  });
  assert.equal(manifest, null);
  await assert.rejects(fs.stat(path.join(f.release, 'patch-manifest.json')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(f.release)).filter(name => name.endsWith('.patch')), []);
});

test('rejects a previous package that does not match its release manifest', async t => {
  const f = await fixture(t);
  const target = targets[0];
  const file = path.join(f.previous, target.filename);
  const bytes = await fs.readFile(file);
  bytes[0] ^= 0xff;
  await fs.writeFile(file, bytes);
  await assert.rejects(buildPatches({
    releaseDir: f.release, previousDir: f.previous, fromTag: 'v1.9.3',
    bsdiffPath: 'bsdiff-fixture.exe', runBsdiff: fakeRunner(), log: () => {}
  }), /Previous package does not match/);
});

test('a generator that emits an invalid patch fails before a manifest is published', async t => {
  const f = await fixture(t);
  await assert.rejects(buildPatches({
    releaseDir: f.release, previousDir: f.previous, fromTag: 'v1.9.3',
    bsdiffPath: 'bsdiff-fixture.exe', runBsdiff: fakeRunner(() => Buffer.from('broken')), log: () => {}
  }), /Patch generation failed/);
  await assert.rejects(fs.stat(path.join(f.release, 'patch-manifest.json')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(f.release)).filter(name => name.endsWith('.patch')), []);
});

test('publication accepts the exact patch set and rejects a missing or extra patch asset', async t => {
  const f = await fixture(t);
  await buildPatches({
    releaseDir: f.release, previousDir: f.previous, fromTag: 'v1.9.3',
    bsdiffPath: 'bsdiff-fixture.exe', runBsdiff: fakeRunner(), log: () => {}
  });
  for (const asset of f.releaseManifest.assets) {
    await fs.writeFile(path.join(f.release, `${asset.name}.sha256`), `${asset.sha256}  ${asset.name}\n`);
  }
  await fs.writeFile(path.join(f.release, 'SHA256SUMS'), checksumLines(f.releaseManifest.assets));
  await verifyPublicationFiles(f.release, f.releaseManifest);
  const patch = (await verifyPatchManifest(f.release, f.releaseManifest)).patches[0];
  await fs.rm(path.join(f.release, patch.name));
  await assert.rejects(verifyPublicationFiles(f.release, f.releaseManifest), /Patch file mismatch|unexpected files|missing/);
});

test('patch publication verification rejects a manifest or patch file changed after generation', async t => {
  const f = await fixture(t);
  await buildPatches({
    releaseDir: f.release, previousDir: f.previous, fromTag: 'v1.9.3',
    bsdiffPath: 'bsdiff-fixture.exe', runBsdiff: fakeRunner(), log: () => {}
  });
  const manifestPath = path.join(f.release, 'patch-manifest.json');
  const original = await fs.readFile(manifestPath);
  const changed = JSON.parse(original);
  changed.patches[0].sha256 = 'f'.repeat(64);
  await fs.writeFile(manifestPath, JSON.stringify(changed));
  await assert.rejects(verifyPatchManifest(f.release, f.releaseManifest), /sidecar|mismatch|Patch|清单/i);
});
