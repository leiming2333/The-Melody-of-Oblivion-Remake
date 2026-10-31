import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { put, list } from '@vercel/blob';
import releaseAssets from './release-assets.cjs';
import releaseTargets from './release-targets.cjs';

const { assertTag, hashFile, walk } = releaseAssets;
const windowsTargets = releaseTargets.targets.filter(target => target.platform === 'win32');

function newerVersion(left, right) {
  const a = String(left).replace(/^v/, '').split('.').map(Number);
  const b = String(right).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function collectReleasePackages(directory, manifest) {
  if (manifest.assets?.length !== releaseTargets.targets.length) throw new Error('Incomplete release manifest');
  const files = (await walk(directory)).filter(file => /\.exe$/i.test(file));
  const packages = [];
  for (const target of windowsTargets) {
    const matches = files.filter(file => path.basename(file) === target.filename);
    if (matches.length !== 1) throw new Error(`Missing or duplicate package: ${target.filename}`);
    const info = await stat(matches[0]);
    if (info.size <= 0) throw new Error(`Empty release package: ${target.filename}`);
    const entry = manifest.assets.filter(asset => asset.name === target.filename);
    const asset = entry[0];
    if (entry.length !== 1 || asset.target !== target.id
      || asset.sha256 !== await hashFile(matches[0]) || asset.size !== info.size) {
      throw new Error(`Release manifest mismatch: ${target.filename}`);
    }
    packages.push({ target, file: matches[0], name: target.filename, size: info.size, sha256: asset.sha256 });
  }
  return packages;
}

export async function syncRelease(assetDirectory, tag, metadataPath, {
  token = process.env.BLOB_READ_WRITE_TOKEN,
  repository = process.env.GITHUB_REPOSITORY || 'leiming2333/The-Melody-of-Oblivion-Remake',
  putBlob = put, listBlobs = list, fetchUrl = fetch
} = {}) {
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required to sync a GitHub Release.');
  const manifest = JSON.parse(await readFile(path.join(assetDirectory, 'release-manifest.json'), 'utf8'));
  assertTag(tag, manifest.version);
  const packages = await collectReleasePackages(assetDirectory, manifest);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.tagName !== tag) throw new Error('GitHub release metadata does not match the requested tag');
  async function existingJson(pathname) {
    const entries = await listBlobs({ prefix: pathname, limit: 2, token });
    const entry = entries.blobs.find(blob => blob.pathname === pathname);
    if (!entry) return null;
    const response = await fetchUrl(entry.url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cannot verify existing Blob metadata: ${pathname}`);
    return response.json();
  }
  const previous = await existingJson(`releases/${tag}/manifest.json`);
  if (previous && JSON.stringify(previous) !== JSON.stringify(manifest)) throw new Error('Published Blob tag is immutable; use a new version');
  const latest = await existingJson('releases/latest.json');
  const assets = [];
  for (const item of packages) {
    const contents = await readFile(item.file);
    const pathname = `releases/${tag}/${item.name}`;
    const blob = await putBlob(pathname, contents, {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      cacheControlMaxAge: 31536000, token
    });
    const response = await fetchUrl(blob.url, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Blob verification failed: ${item.name}`);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) { hash.update(chunk); size += chunk.length; }
    if (size !== item.size || hash.digest('hex') !== item.sha256) throw new Error(`Blob digest mismatch: ${item.name}`);
    assets.push({ name: item.name, size: item.size,
      platform: `Windows-${item.target.arch}`,
      digest: `sha256:${item.sha256}`, browser_download_url: blob.url,
      github_download_url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(item.name)}` });
  }
  await putBlob(`releases/${tag}/manifest.json`, JSON.stringify(manifest), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    cacheControlMaxAge: 31536000, contentType: 'application/json; charset=utf-8', token
  });
  if (latest?.tag_name && newerVersion(latest.tag_name, tag)) return { tag, assets, latestUpdated: false };
  const release = { tag_name: tag, name: metadata.name || tag,
    html_url: metadata.url || `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
    body: metadata.body || '', published_at: metadata.publishedAt || null, assets };
  await putBlob('releases/latest.json', JSON.stringify(release), {
    access: 'public', addRandomSuffix: false, allowOverwrite: true,
    cacheControlMaxAge: 60, contentType: 'application/json; charset=utf-8', token
  });
  return { ...release, latestUpdated: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [assetDirectory, tag, metadataPath] = process.argv.slice(2);
  syncRelease(assetDirectory, tag, metadataPath)
    .then(result => console.log(`Verified ${result.assets.length} Windows Blob packages for ${tag}; latest updated: ${result.latestUpdated}.`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
