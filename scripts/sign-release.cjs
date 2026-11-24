'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashFile } = require('./release-assets.cjs');
const { keyFingerprint, signAsset, verifyAssetSignature } = require('../src/main/updater/release-signature');
const trustPath = path.join(__dirname, '../src/main/updater/release-trust.json');

function assertTrustedKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('Configure a release signing public key before publishing; see docs/release-signing.md');
  const ids = new Set();
  for (const key of keys) {
    if (keyFingerprint(key.publicKey) !== key.keyId || ids.has(key.keyId)) throw new Error('Invalid or duplicate release signing public key');
    ids.add(key.keyId);
  }
  return keys;
}

async function signDirectory(directory, { tag, privateKey, keys = require(trustPath).keys } = {}) {
  assertSigningKey(privateKey, keys);
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('A stable release tag is required for signing');
  const names = (await fs.readdir(directory)).filter(name => !name.endsWith('.sig')).sort();
  if (!names.length) throw new Error('No release files to sign');
  const signatures = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release signing input is not a regular file: ${name}`);
    const metadata = { tag, name, size: stat.size, sha256: await hashFile(file) };
    const value = signAsset(metadata, privateKey);
    const text = `${JSON.stringify(value, null, 2)}\n`;
    verifyAssetSignature(text, metadata, keys);
    const sidecarStat = await fs.lstat(`${file}.sig`).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (sidecarStat && (!sidecarStat.isFile() || sidecarStat.isSymbolicLink())) throw new Error(`Invalid signature output: ${name}.sig`);
    signatures.push({ name, text });
  }
  // Validate every file and the configured key before creating any sidecars.
  for (const { name, text } of signatures) await fs.writeFile(path.join(directory, `${name}.sig`), text);
  return signatures.length;
}

function assertSigningKey(privateKey, keys = require(trustPath).keys) {
  assertTrustedKeys(keys);
  if (!privateKey) throw new Error('MELODY_RELEASE_SIGNING_KEY is required; use an Ed25519 PKCS#8 PEM private key stored in CI secrets');
  const metadata = { tag: 'v0.0.0', name: 'release-signing-preflight', size: 1, sha256: '0'.repeat(64) };
  verifyAssetSignature(JSON.stringify(signAsset(metadata, privateKey)), metadata, keys);
}

async function generateKey(privateKeyPath, publicConfigPath = trustPath) {
  const target = path.resolve(privateKeyPath);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  const keyId = keyFingerprint(publicKey);
  const config = JSON.parse(await fs.readFile(publicConfigPath, 'utf8'));
  if (config.schemaVersion !== 1 || !Array.isArray(config.keys)) throw new Error('Invalid release trust configuration');
  // The operator chooses a location outside the repository and backs it up.
  const repository = path.resolve(__dirname, '..');
  const relative = path.relative(repository, target);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('Store the private signing key outside the repository');
  await fs.writeFile(target, privateKey, { flag: 'wx', mode: 0o600 });
  config.keys.push({ keyId, publicKey });
  await fs.writeFile(publicConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  return { keyId, privateKeyPath: target };
}

if (require.main === module) {
  const [argument, destination] = process.argv.slice(2);
  const operation = argument === '--generate-key'
    ? generateKey(destination).then(result => console.log(`Public key SHA-256: ${result.keyId}\nPrivate key saved outside the repository: ${result.privateKeyPath}\nBack up the private key securely and configure MELODY_RELEASE_SIGNING_KEY in CI. Never commit it.`))
    : signDirectory(argument, { tag: process.env.RELEASE_TAG, privateKey: process.env.MELODY_RELEASE_SIGNING_KEY })
      .then(count => console.log(`Signed ${count} release assets with Ed25519`));
  operation.catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { signDirectory, generateKey, assertTrustedKeys, assertSigningKey };
