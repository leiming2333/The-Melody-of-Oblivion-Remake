import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { put, list } from '@vercel/blob';
import releaseAssets from './release-assets.cjs';

const { assertTag, verifyManifest } = releaseAssets;

function newerVersion(left, right) {
  const a = String(left).replace(/^v/, '').split('.').map(Number);
  const b = String(right).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export async function syncRelease(assetDirectory, tag, metadataPath, {
  token = process.env.BLOB_READ_WRITE_TOKEN,
  repository = process.env.GITHUB_REPOSITORY || 'leiming2333/The-Melody-of-Oblivion-Remake',
  putBlob = put, listBlobs = list, fetchUrl = fetch
} = {}) {
  if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required to sync a GitHub Release.');
  const manifest = JSON.parse(await readFile(path.join(assetDirectory, 'release-manifest.json'), 'utf8'));
  assertTag(tag, manifest.version);
  const packages = await verifyManifest(assetDirectory, manifest);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.tagName !== tag) throw new Error('GitHub release metadata does not match the requested tag');
  async function existingBlob(pathname) {
    const entries = await listBlobs({ prefix: pathname, limit: 2, token });
    return entries.blobs.find(blob => blob.pathname === pathname) ?? null;
  }
  async function existingJson(pathname) {
    const entry = await existingBlob(pathname);
    if (!entry) return null;
    const response = await fetchUrl(entry.url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Cannot verify existing Blob metadata: ${pathname}`);
    return response.json();
  }
  const previous = await existingJson(`releases/${tag}/manifest.json`);
  if (previous && !isDeepStrictEqual(previous, manifest)) throw new Error('Published Blob tag is immutable; use a new version');
  const latest = await existingJson('releases/latest.json');
  async function verifyBlob(blob, item) {
    const response = await fetchUrl(blob.url, { cache: 'no-store',
      headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Blob verification failed: ${item.name}`);
    if (!response.body) throw new Error(`Blob verification failed: ${item.name}`);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.length;
      if (size > item.size) throw new Error(`Blob digest mismatch: ${item.name}`);
    }
    if (size !== item.size || hash.digest('hex') !== item.sha256) throw new Error(`Blob digest mismatch: ${item.name}`);
  }
  // Reuse published bytes without overwriting them. The old Windows-only sync
  // already published the complete manifest, so the same tag may add its other
  // verified platforms while keeping that manifest and existing objects intact.
  const existing = new Map();
  for (const item of packages) {
    const blob = await existingBlob(`releases/${tag}/${item.name}`);
    if (!blob) continue;
    try { await verifyBlob(blob, item); }
    catch { throw new Error(`Published Blob asset is immutable or unavailable: ${item.name}`); }
    existing.set(item.name, blob);
  }
  const assets = [];
  for (const item of packages) {
    let blob = existing.get(item.name);
    if (!blob) {
      const contents = await readFile(item.file);
      blob = await putBlob(`releases/${tag}/${item.name}`, contents, {
        access: 'public', addRandomSuffix: false, allowOverwrite: false,
        cacheControlMaxAge: 31536000, token
      });
      await verifyBlob(blob, item);
    }
    assets.push({ name: item.name, size: item.size,
      platform: `${{ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[item.target.platform]}-${item.target.arch}`,
      digest: `sha256:${item.sha256}`, browser_download_url: blob.url,
      github_download_url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(item.name)}` });
  }
  if (!previous) await putBlob(`releases/${tag}/manifest.json`, JSON.stringify(manifest), {
    access: 'public', addRandomSuffix: false, allowOverwrite: false,
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
    .then(result => console.log(`Verified ${result.assets.length} cross-platform Blob packages for ${tag}; latest updated: ${result.latestUpdated}.`))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
