import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { put } from '@vercel/blob';

const [assetDirectory, tag, metadataPath] = process.argv.slice(2);
const token = process.env.BLOB_READ_WRITE_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || 'leiming2333/The-Melody-of-Oblivion-Remake';

if (!token) throw new Error('BLOB_READ_WRITE_TOKEN is required to sync a GitHub Release.');
if (!assetDirectory || !/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !metadataPath) {
  throw new Error('Usage: node scripts/sync-release-to-blob.mjs <asset-directory> <tag> <release-metadata.json>');
}

const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const files = (await readdir(assetDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.(?:exe|zip|AppImage)$/i.test(entry.name))
  .map((entry) => entry.name)
  .sort();

if (!files.length) throw new Error(`No installer assets found for ${tag}.`);

const assets = [];
for (const name of files) {
  const version = name.match(/-v(\d+\.\d+\.\d+)-/i)?.[1];
  if (version && `v${version}` !== tag) throw new Error(`Asset ${name} does not match release ${tag}.`);
  if (!/^The-Melody-of-Oblivion-Remake-(?:v\d+\.\d+\.\d+-)?(?:Windows-(?:Setup-)?(?:x64|ia32|arm64)\.exe|Windows-(?:x64|ia32|arm64)\.zip|macOS-(?:x64|arm64)\.zip|Linux-(?:x64|arm64|armv7l)\.AppImage)$/i.test(name)) {
    throw new Error(`Unexpected release asset name: ${name}`);
  }

  const contents = await readFile(path.join(assetDirectory, name));
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const pathname = `releases/${tag}/${name}`;
  const blob = await put(pathname, contents, {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31536000,
    token
  });

  assets.push({
    name,
    size: contents.length,
    platform: name.match(/(Windows-(?:Setup-)?(?:x64|ia32|arm64)|macOS-(?:x64|arm64)|Linux-(?:x64|arm64|armv7l))/i)?.[1],
    digest: `sha256:${sha256}`,
    browser_download_url: blob.url,
    github_download_url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
  });
  console.log(`Uploaded ${name} (${contents.length} bytes)`);
}

const release = {
  tag_name: tag,
  name: metadata.name || tag,
  html_url: metadata.url || `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`,
  body: metadata.body || '',
  published_at: metadata.publishedAt || null,
  assets
};

await put('releases/latest.json', JSON.stringify(release), {
  access: 'public',
  addRandomSuffix: false,
  allowOverwrite: true,
  cacheControlMaxAge: 60,
  contentType: 'application/json; charset=utf-8',
  token
});

console.log(`Published Blob manifest for ${tag} with ${assets.length} assets.`);
