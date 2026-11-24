const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SIGNATURE_MAX_BYTES, keyFingerprint, signAsset, verifyAssetSignature, readBoundedText } = require('../src/main/updater/release-signature');
const { assertTrustedKeys, signDirectory, generateKey } = require('../scripts/sign-release.cjs');
const { platformSigningArguments } = require('../scripts/platform-signing.cjs');
const { publishRelease } = require('../scripts/publish-release.cjs');

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  return { ...pair, keyId: keyFingerprint(pair.publicKey) };
}

const key = keyPair();
const otherKey = keyPair();
const trusted = [{ keyId: key.keyId, publicKey: key.publicKey }];
const metadata = { tag: 'v2.2.0', name: 'The-Melody-of-Oblivion-Remake-Windows-x64.exe', size: 27, sha256: 'a'.repeat(64) };
const invalidSignature = error => error.code === 'UPDATE_SIGNATURE_INVALID';
const encoded = value => JSON.stringify(value);

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-release-signature-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('release signatures bind stable version, exact asset identity and hash to the pinned Ed25519 key', () => {
  const signed = signAsset(metadata, key.privateKey);
  assert.deepEqual(verifyAssetSignature(encoded(signed), metadata, trusted), signed);
  assert.equal(signed.keyId, crypto.createHash('sha256')
    .update(crypto.createPublicKey(key.publicKey).export({ type: 'spki', format: 'der' })).digest('hex'));
  assert.equal(Buffer.from(signed.signature, 'base64').length, 64);
  // Callers cannot replace the signing domain, algorithm or actual key identity.
  const spoofed = signAsset({ ...metadata, keyId: otherKey.keyId, algorithm: 'RSA', schemaVersion: 9 }, key.privateKey);
  assert.deepEqual(spoofed, signed);
});

test('modifying any signed identity or hash fails even when the expected metadata is modified with it', () => {
  const signed = signAsset(metadata, key.privateKey);
  for (const mutation of [
    { tag: 'v2.2.1' }, { name: 'another.exe' }, { size: metadata.size + 1 }, { sha256: 'b'.repeat(64) }
  ]) {
    assert.throws(() => verifyAssetSignature(encoded({ ...signed, ...mutation }), { ...metadata, ...mutation }, trusted), invalidSignature);
  }
  const bytes = Buffer.from(signed.signature, 'base64');
  bytes[17] ^= 1;
  assert.throws(() => verifyAssetSignature(encoded({ ...signed, signature: bytes.toString('base64') }), metadata, trusted), invalidSignature);
});

test('valid signatures cannot be replayed for another version, filename or package size', () => {
  const signed = encoded(signAsset(metadata, key.privateKey));
  for (const mutation of [{ tag: 'v2.3.0' }, { name: 'another.exe' }, { size: metadata.size + 1 }]) {
    assert.throws(() => verifyAssetSignature(signed, { ...metadata, ...mutation }, trusted), invalidSignature);
  }
});

test('unknown keys, forged key IDs and non-Ed25519 signing keys are refused', () => {
  const signed = signAsset(metadata, key.privateKey);
  assert.throws(() => verifyAssetSignature(encoded(signed), metadata, []), invalidSignature);
  assert.throws(() => verifyAssetSignature(encoded(signAsset(metadata, otherKey.privateKey)), metadata, trusted), invalidSignature);
  assert.throws(() => verifyAssetSignature(encoded(signed), metadata, [{ keyId: key.keyId, publicKey: otherKey.publicKey }]), invalidSignature);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  assert.throws(() => keyFingerprint(rsa.publicKey), invalidSignature);
  assert.throws(() => signAsset(metadata, rsa.privateKey), invalidSignature);
});

test('malformed, oversized and unsafe signature metadata fails closed', () => {
  const signed = signAsset(metadata, key.privateKey);
  for (const value of ['{', 'null', '[]', '{}', ' '.repeat(SIGNATURE_MAX_BYTES + 1)]) {
    assert.throws(() => verifyAssetSignature(value, metadata, trusted), invalidSignature);
  }
  assert.throws(() => verifyAssetSignature(Buffer.from(encoded(signed)), metadata, trusted), invalidSignature);
  for (const mutation of [
    { schemaVersion: 2 }, { algorithm: 'RSA' }, { keyId: 'invalid' }, { tag: 'v2.2.0-beta.1' },
    { name: '' }, { name: '.' }, { name: '..' }, { name: '../payload.exe' }, { name: 'folder\\payload.exe' },
    { name: 'payload\u0000.exe' }, { name: 'payload\n.exe' }, { name: 'a'.repeat(256) },
    { size: 0 }, { size: -1 }, { size: 1.5 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { size: '27' },
    { sha256: 'x'.repeat(64) }, { sha256: 'a'.repeat(63) }, { signature: '' }, { signature: 'a'.repeat(88) }
  ]) {
    assert.throws(() => verifyAssetSignature(encoded({ ...signed, ...mutation }), metadata, trusted), invalidSignature);
  }
});

test('bounded signature reads reject advertised oversize bodies before consuming them', async () => {
  let cancelled = false;
  let consumed = false;
  await assert.rejects(readBoundedText({
    headers: { get: () => String(SIGNATURE_MAX_BYTES + 1) },
    body: { async cancel() { cancelled = true; } },
    async text() { consumed = true; return ''; }
  }), invalidSignature);
  assert.equal(cancelled, true);
  assert.equal(consumed, false);
});

test('bounded signature reads cancel lying or lengthless streams as soon as the byte limit is crossed', async () => {
  for (const declaredLength of [null, '1']) {
    let reads = 0;
    let cancels = 0;
    let releases = 0;
    const reader = {
      async read() { reads++; return { done: false, value: Buffer.alloc(9) }; },
      async cancel() { cancels++; },
      releaseLock() { releases++; }
    };
    await assert.rejects(readBoundedText({ headers: { get: () => declaredLength }, body: { getReader: () => reader } }, 16), invalidSignature);
    assert.equal(reads, 2);
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
  }
});

test('a failing stream cancellation cannot turn oversized signature metadata into an accepted response', async () => {
  await assert.rejects(readBoundedText({
    headers: { get: () => String(SIGNATURE_MAX_BYTES + 1) },
    body: { async cancel() { throw new Error('cancel failed'); } }
  }), invalidSignature);
  let released = false;
  await assert.rejects(readBoundedText({ body: { getReader: () => ({
    async read() { return { done: false, value: Buffer.alloc(17) }; },
    async cancel() { throw new Error('cancel failed'); },
    releaseLock() { released = true; }
  }) } }, 16), invalidSignature);
  assert.equal(released, true);
});

test('bounded signature reads preserve multibyte UTF-8 across chunks and release the stream reader', async () => {
  const text = '{"message":"中"}';
  const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.subarray(0, split));
    controller.enqueue(bytes.subarray(split));
    controller.close();
  } });
  assert.equal(await readBoundedText(new Response(stream), bytes.length), text);
  assert.equal(stream.locked, false);
  assert.equal(await readBoundedText({ async text() { return '中'; } }, 3), '中');
  await assert.rejects(readBoundedText({ async text() { return '中'; } }, 2), invalidSignature);
  let released = false;
  await assert.rejects(readBoundedText({ body: { getReader: () => ({
    async read() { throw new Error('stream failed'); }, releaseLock() { released = true; }
  }) } }), /stream failed/);
  assert.equal(released, true);
});

test('release trust configuration rejects missing, duplicate and mismatched public keys', () => {
  for (const value of [undefined, null, [], {}]) assert.throws(() => assertTrustedKeys(value), /Configure a release signing public key/);
  assert.throws(() => assertTrustedKeys([trusted[0], trusted[0]]), /duplicate/);
  assert.throws(() => assertTrustedKeys([{ keyId: key.keyId, publicKey: otherKey.publicKey }]), /Invalid/);
  assert.equal(assertTrustedKeys(trusted), trusted);
});

test('release directory signing validates all inputs and the private key before writing sidecars', async t => {
  const directory = await temporary(t);
  await fs.writeFile(path.join(directory, 'a.exe'), 'package bytes');
  await fs.writeFile(path.join(directory, 'b.json'), '{"release":true}');
  await assert.rejects(signDirectory(directory, { tag: metadata.tag, keys: trusted }), /MELODY_RELEASE_SIGNING_KEY/);
  await assert.rejects(signDirectory(directory, { tag: metadata.tag, privateKey: otherKey.privateKey, keys: trusted }), invalidSignature);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['a.exe', 'b.json']);
  await fs.mkdir(path.join(directory, 'z-directory'));
  await assert.rejects(signDirectory(directory, { tag: metadata.tag, privateKey: key.privateKey, keys: trusted }), /not a regular file/);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['a.exe', 'b.json', 'z-directory']);
  await fs.rmdir(path.join(directory, 'z-directory'));
  assert.equal(await signDirectory(directory, { tag: metadata.tag, privateKey: key.privateKey, keys: trusted }), 2);
  for (const name of ['a.exe', 'b.json']) {
    const data = await fs.readFile(path.join(directory, name));
    const signed = verifyAssetSignature(await fs.readFile(path.join(directory, `${name}.sig`), 'utf8'),
      { tag: metadata.tag, name, size: data.length }, trusted);
    assert.equal(signed.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  }
  // Re-signing skips existing sidecars rather than recursively signing signatures.
  assert.equal(await signDirectory(directory, { tag: metadata.tag, privateKey: key.privateKey, keys: trusted }), 2);
  assert.equal((await fs.readdir(directory)).length, 4);
});

test('release signing refuses empty directories, empty files and non-stable tags', async t => {
  const directory = await temporary(t);
  const options = { tag: metadata.tag, privateKey: key.privateKey, keys: trusted };
  await assert.rejects(signDirectory(directory, options), /No release files/);
  await fs.writeFile(path.join(directory, 'empty.exe'), '');
  await assert.rejects(signDirectory(directory, options), invalidSignature);
  await assert.rejects(signDirectory(directory, { ...options, tag: 'v2.2.0-beta.1' }), /stable release tag/);
  assert.deepEqual(await fs.readdir(directory), ['empty.exe']);
});

test('key generation stores only public trust metadata and never overwrites a private key', async t => {
  const directory = await temporary(t);
  const privatePath = path.join(directory, 'private.pem');
  const configPath = path.join(directory, 'trust.json');
  const initial = { schemaVersion: 1, keys: trusted };
  await fs.writeFile(configPath, encoded(initial));
  const result = await generateKey(privatePath, configPath);
  const privateText = await fs.readFile(privatePath, 'utf8');
  const configText = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(configText);
  assert.equal(config.keys.length, 2);
  assert.deepEqual(config.keys[0], trusted[0]);
  assert.equal(config.keys[1].keyId, result.keyId);
  assert.equal(keyFingerprint(crypto.createPublicKey(privateText).export({ type: 'spki', format: 'pem' })), result.keyId);
  assert.ok(!configText.includes('PRIVATE KEY'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(privatePath)).mode & 0o077, 0);
  await assert.rejects(generateKey(privatePath, configPath), { code: 'EEXIST' });
  assert.equal(await fs.readFile(privatePath, 'utf8'), privateText);
  assert.equal(await fs.readFile(configPath, 'utf8'), configText);
});

test('key generation refuses repository private key paths and invalid trust configurations before writing keys', async t => {
  const directory = await temporary(t);
  const configPath = path.join(directory, 'trust.json');
  const forbidden = path.join(__dirname, `signing-private-${crypto.randomUUID()}.pem`);
  await fs.writeFile(configPath, encoded({ schemaVersion: 1, keys: [] }));
  await assert.rejects(generateKey(forbidden, configPath), /outside the repository/);
  await assert.rejects(fs.access(forbidden), { code: 'ENOENT' });
  const target = path.join(directory, 'must-not-exist.pem');
  await fs.writeFile(configPath, encoded({ schemaVersion: 2, keys: [] }));
  await assert.rejects(generateKey(target, configPath), /Invalid release trust configuration/);
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
});

test('platform signing enforcement checks Windows certificates and all macOS notarization credentials', () => {
  assert.deepEqual(platformSigningArguments('win32', {}), []);
  assert.deepEqual(platformSigningArguments('linux', { MELODY_REQUIRE_CODE_SIGNING: 'true' }), []);
  assert.throws(() => platformSigningArguments('win32', { MELODY_REQUIRE_CODE_SIGNING: 'true' }), /CSC_LINK/);
  assert.deepEqual(platformSigningArguments('win32', { MELODY_REQUIRE_CODE_SIGNING: 'true', CSC_LINK: 'certificate.pfx' }), ['--config.forceCodeSigning=true']);
  const mac = { MELODY_REQUIRE_CODE_SIGNING: 'true', CSC_LINK: 'certificate.p12',
    APPLE_ID: 'developer@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'TEAM12345' };
  for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    const missing = { ...mac };
    delete missing[name];
    assert.throws(() => platformSigningArguments('darwin', missing), /notarization credentials/);
  }
  assert.deepEqual(platformSigningArguments('darwin', mac), ['--config.forceCodeSigning=true']);
});

test('production publication refuses an empty trust store before reading packages or contacting GitHub', async () => {
  let contacted = false;
  const run = async () => { contacted = true; throw new Error('must not contact GitHub'); };
  const missingDirectory = path.join(os.tmpdir(), `missing-release-${crypto.randomUUID()}`);
  await assert.rejects(publishRelease(missingDirectory, metadata.tag, 'owner/repository', run, { trustedKeys: [] }), /Configure a release signing public key/);
  assert.equal(contacted, false);
  // Legacy lifecycle fixtures opt out explicitly; production CLI exposes no such option.
  await assert.rejects(publishRelease(missingDirectory, metadata.tag, 'owner/repository', run,
    { trustedKeys: [], requireSignatures: false }), { code: 'ENOENT' });
  assert.equal(contacted, false);
});
