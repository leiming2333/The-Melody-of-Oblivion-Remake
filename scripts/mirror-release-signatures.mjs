import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import releaseAssets from './release-assets.cjs';
import signatureTools from '../src/main/updater/release-signature.js';
import trust from '../src/main/updater/release-trust.json' with { type: 'json' };

const { hashFile } = releaseAssets;
const { SIGNATURE_MAX_BYTES, verifyAssetSignature } = signatureTools;

// Finish local validation before an immutable mirror object or latest is written.
export async function mirrorSignatures(directory, tag, requiredNames, trustedKeys = trust.keys) {
  if (!Array.isArray(trustedKeys)) throw new Error('Invalid mirror release trust configuration');
  const names = (await readdir(directory)).filter(name => name.endsWith('.sig')).sort();
  if (trustedKeys.length) {
    for (const name of requiredNames) {
      if (!names.includes(`${name}.sig`)) throw new Error(`Missing release signature: ${name}.sig`);
    }
  }
  const items = [];
  for (const name of names) {
    const signedName = name.slice(0, -4);
    const file = path.join(directory, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SIGNATURE_MAX_BYTES) {
      throw new Error(`Invalid release signature file: ${name}`);
    }
    const baseFile = path.join(directory, signedName);
    const baseStat = await lstat(baseFile);
    if (!baseStat.isFile() || baseStat.isSymbolicLink()) throw new Error(`Invalid signed release file: ${signedName}`);
    const bytes = await readFile(file);
    const verified = verifyAssetSignature(bytes.toString('utf8'), {
      tag, name: signedName, size: baseStat.size
    }, trustedKeys);
    if (verified.sha256 !== await hashFile(baseFile)) throw new Error(`Signed release digest mismatch: ${signedName}`);
    items.push({ name, file, size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signedFile: { name: signedName, file: baseFile, size: baseStat.size, sha256: verified.sha256 } });
  }
  return items;
}
