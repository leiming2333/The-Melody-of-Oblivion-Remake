const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const {
  applyDeltaPatch,
  normalizeTag,
  readPatchManifest,
  selectPatch
} = require('../src/main/updater/update-patch');

function i64(value) {
  const bytes = Buffer.alloc(8);
  let number = BigInt(value);
  if (number < 0n) {
    number = -number;
    bytes[7] |= 0x80;
  }
  for (let index = 0; index < 7; index += 1) {
    bytes[index] = Number(number & 0xffn);
    number >>= 8n;
  }
  bytes[7] |= Number(number & 0x7fn);
  return bytes;
}

function trdiffPatch({ control, diff = Buffer.alloc(0), extra = Buffer.alloc(0), newSize }) {
  const compressed = [control, diff, extra].map(value => zlib.zstdCompressSync(value));
  return Buffer.concat([
    Buffer.from('TRDIFF10'), i64(compressed[0].length), i64(compressed[1].length), i64(newSize),
    ...compressed
  ]);
}

function extraOnlyPatch(oldBytes, newBytes) {
  return trdiffPatch({
    control: Buffer.concat([i64(0), i64(newBytes.length), i64(0)]),
    extra: newBytes,
    newSize: newBytes.length
  });
}

async function tempFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-patch-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const manifest = {
  schemaVersion: 1,
  from: 'v1.9.3',
  to: 'v1.9.4',
  patches: [{
    name: 'patch-v1.9.3-to-v1.9.4-windows-x64.patch',
    asset: 'The-Melody-of-Oblivion-Remake-Windows-x64.exe',
    target: 'windows-x64',
    size: 1024,
    sha256: 'a'.repeat(64),
    fromSha256: 'b'.repeat(64),
    toSha256: 'c'.repeat(64),
    toSize: 2048
  }]
};

test('normalizes version tags and rejects non-release tags', () => {
  assert.equal(normalizeTag('1.9.3'), 'v1.9.3');
  assert.equal(normalizeTag('v1.9.3'), 'v1.9.3');
  assert.equal(normalizeTag('v1.9'), null);
  assert.equal(normalizeTag('latest'), null);
});

test('reads a bound patch manifest and selects only the matching platform asset', () => {
  const parsed = readPatchManifest(manifest, { currentTag: 'v1.9.3', targetTag: 'v1.9.4' });
  assert.equal(parsed.patches.length, 1);
  assert.equal(selectPatch(parsed, { from: 'v1.9.3', assetName: manifest.patches[0].asset,
    target: 'windows-x64' }).name, manifest.patches[0].name);
  assert.equal(selectPatch(parsed, { from: 'v1.9.3', assetName: manifest.patches[0].asset,
    target: 'linux-x64' }), null);
  assert.equal(selectPatch(parsed, { from: 'v1.9.2', assetName: manifest.patches[0].asset,
    target: 'windows-x64' }), null);
  assert.equal(selectPatch(parsed, { from: 'v1.9.3', assetName: 'other.exe',
    target: 'windows-x64' }), null);
});

test('selects a patch source for any of the latest three installed versions', () => {
  const base = manifest.patches[0];
  const sources = ['v1.9.4', 'v1.9.3', 'v1.9.2'].map((from, index) => ({
    from,
    patches: [{ ...base, name: `patch-${from}-to-v1.9.5-windows-x64.patch`,
      fromSha256: String(index + 1).repeat(64) }]
  }));
  const multi = {
    schemaVersion: 1, from: 'v1.9.4', to: 'v1.9.5',
    patches: sources[0].patches, sources
  };
  const parsed = readPatchManifest(multi, { currentTag: 'v1.9.2', targetTag: 'v1.9.5' });
  assert.equal(parsed.sources.length, 3);
  assert.equal(selectPatch(parsed, { from: 'v1.9.4', assetName: base.asset, target: 'windows-x64' }).name,
    sources[0].patches[0].name);
  assert.equal(selectPatch(parsed, { from: 'v1.9.3', assetName: base.asset, target: 'windows-x64' }).name,
    sources[1].patches[0].name);
  assert.equal(selectPatch(parsed, { from: 'v1.9.2', assetName: base.asset, target: 'windows-x64' }).name,
    sources[2].patches[0].name);
  assert.equal(selectPatch(parsed, { from: 'v1.9.1', assetName: base.asset, target: 'windows-x64' }), null);
  assert.throws(() => readPatchManifest(multi, { currentTag: 'v1.9.1', targetTag: 'v1.9.5' }),
    { code: 'PATCH_MANIFEST_INVALID' });
  assert.throws(() => readPatchManifest({ ...multi, patches: [{ ...base, name: 'different.patch' }] },
    { currentTag: 'v1.9.4', targetTag: 'v1.9.5' }), { code: 'PATCH_MANIFEST_INVALID' });
});

test('patch manifests fail closed for version, path, digest, and size errors', () => {
  for (const value of [
    null,
    { ...manifest, schemaVersion: 2 },
    { ...manifest, from: 'v1.9.2' },
    { ...manifest, to: 'v1.9.5' },
    { ...manifest, patches: {} },
    { ...manifest, patches: [] },
    { ...manifest, patches: [{ ...manifest.patches[0], name: '../escape.patch' }] },
    { ...manifest, patches: [{ ...manifest.patches[0], asset: '../escape.exe' }] },
    { ...manifest, patches: [{ ...manifest.patches[0], sha256: 'x'.repeat(64) }] },
    { ...manifest, patches: [{ ...manifest.patches[0], size: 0 }] },
    { ...manifest, patches: [{ ...manifest.patches[0], toSize: 0 }] },
    { ...manifest, patches: [{ ...manifest.patches[0] }, { ...manifest.patches[0] }] }
  ]) {
    assert.throws(() => readPatchManifest(value, { currentTag: 'v1.9.3', targetTag: 'v1.9.4' }),
      { code: 'PATCH_MANIFEST_INVALID' });
  }
});

test('applies a TRDIFF10 patch and verifies the exact target digest and size', async t => {
  const directory = await tempFixture(t);
  const oldPath = path.join(directory, 'old.bin');
  const destPath = path.join(directory, 'new.bin');
  const oldBytes = Buffer.from('old launcher bytes');
  const newBytes = Buffer.from('new launcher bytes with a changed payload');
  await fs.writeFile(oldPath, oldBytes);
  const digest = createHash('sha256').update(newBytes).digest('hex');
  const result = await applyDeltaPatch({
    oldPath, patchData: extraOnlyPatch(oldBytes, newBytes), destPath,
    expectedSize: newBytes.length, expectedSha256: digest
  });
  assert.equal(result.sha256, digest);
  assert.equal(result.size, newBytes.length);
  assert.deepEqual(await fs.readFile(destPath), newBytes);
});

test('applies a bsdiff-style control/diff patch rather than only an extra block', async t => {
  const directory = await tempFixture(t);
  const oldPath = path.join(directory, 'old.bin');
  const destPath = path.join(directory, 'new.bin');
  const oldBytes = Buffer.from('ABCDEFGH');
  await fs.writeFile(oldPath, oldBytes);
  // First 8 bytes come from old + zero diff, then one extra byte is appended.
  const patch = trdiffPatch({
    control: Buffer.concat([i64(8), i64(1), i64(0)]),
    diff: Buffer.alloc(8),
    extra: Buffer.from('!'),
    newSize: 9
  });
  const newBytes = Buffer.from('ABCDEFGH!');
  const digest = createHash('sha256').update(newBytes).digest('hex');
  await applyDeltaPatch({ oldPath, patchData: patch, destPath,
    expectedSize: newBytes.length, expectedSha256: digest });
  assert.deepEqual(await fs.readFile(destPath), newBytes);
});

test('rejects malformed patches, wrong target sizes, wrong hashes, and cancellation', async t => {
  const directory = await tempFixture(t);
  const oldPath = path.join(directory, 'old.bin');
  await fs.writeFile(oldPath, Buffer.from('old bytes'));
  const newBytes = Buffer.from('new bytes');
  const patch = extraOnlyPatch(Buffer.from('old bytes'), newBytes);
  const digest = createHash('sha256').update(newBytes).digest('hex');
  const dest = path.join(directory, 'out.bin');
  await assert.rejects(applyDeltaPatch({ oldPath, patchData: Buffer.from('not a patch'), destPath: dest,
    expectedSize: newBytes.length, expectedSha256: digest }), { code: 'PATCH_INVALID' });
  await assert.rejects(applyDeltaPatch({ oldPath, patchData: patch, destPath: dest,
    expectedSize: newBytes.length + 1, expectedSha256: digest }), { code: 'PATCH_SIZE_MISMATCH' });
  await assert.rejects(applyDeltaPatch({ oldPath, patchData: patch, destPath: dest,
    expectedSize: newBytes.length, expectedSha256: 'd'.repeat(64) }), { code: 'PATCH_HASH_MISMATCH' });
  await assert.rejects(fs.stat(dest));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(applyDeltaPatch({ oldPath, patchData: patch, destPath: dest,
    expectedSize: newBytes.length, expectedSha256: digest, signal: controller.signal }), { name: 'AbortError' });
});

test('a patch output outside the requested size is removed before callers can install it', async t => {
  const directory = await tempFixture(t);
  const oldPath = path.join(directory, 'old.bin');
  const dest = path.join(directory, 'out.bin');
  await fs.writeFile(oldPath, Buffer.from('old'));
  const patch = extraOnlyPatch(Buffer.from('old'), Buffer.from('new'));
  await assert.rejects(applyDeltaPatch({ oldPath, patchData: patch, destPath: dest,
    expectedSize: 4, expectedSha256: createHash('sha256').update('new').digest('hex') }),
  { code: 'PATCH_SIZE_MISMATCH' });
  await assert.rejects(fs.stat(dest));
});
