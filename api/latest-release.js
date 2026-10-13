const RELEASE_API = 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest';
const { isStableRelease, withBlobDownloads } = require('../src/shared/release-metadata');

async function latestBlobRelease() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: 'releases/latest.json', limit: 10 });
    const manifestBlob = blobs.find((blob) => blob.pathname === 'releases/latest.json');
    if (!manifestBlob) return null;
    const response = await fetch(manifestBlob.url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const manifest = await response.json();
    if (!manifest || !/^v\d+\.\d+\.\d+$/.test(manifest.tag_name) || !Array.isArray(manifest.assets)) return null;
    return manifest;
  } catch {
    return null;
  }
}

async function readChecksum(asset, fetchImpl) {
  const sidecar = asset.checksumAsset;
  if (!sidecar?.browser_download_url?.startsWith('https://github.com/')) return null;
  try {
    const response = await fetchImpl(sidecar.browser_download_url, {
      headers: { 'User-Agent': 'melody-of-oblivion-website' },
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) return null;
    const checksum = (await response.text()).match(/^([a-f\d]{64})(?:\s|$)/im)?.[1];
    return checksum ? `sha256:${checksum.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

function createLatestReleaseHandler({
  fetchImpl = (...args) => fetch(...args),
  readBlobRelease = latestBlobRelease
} = {}) {
  return async function latestRelease(_request, response) {
    try {
      // A successful Blob sync may still describe an older release or a backfilled tag.
      // Verify latest on GitHub before advertising a version or reusing Blob assets.
      const upstream = await fetchImpl(RELEASE_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'melody-of-oblivion-website'
        },
        signal: AbortSignal.timeout(10000)
      });
      if (!upstream.ok) {
        response.status(502).json({ error: 'Release information is unavailable' });
        return;
      }
      const release = await upstream.json();
      if (!isStableRelease(release)) throw new Error('Invalid release metadata');
      const checksumAssets = new Map(release.assets
        .filter((asset) => asset.name?.endsWith('.sha256'))
        .map((asset) => [asset.name.slice(0, -'.sha256'.length), asset]));
      await Promise.all(release.assets.map(async (asset) => {
        if (!asset.name || !/\.(?:exe|zip|AppImage)$/i.test(asset.name)) return;
        if (!/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '')) {
          asset.digest = await readChecksum({ ...asset, checksumAsset: checksumAssets.get(asset.name) }, fetchImpl);
        }
      }));
      const blobRelease = await readBlobRelease();
      response.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      response.status(200).json(withBlobDownloads(release, blobRelease));
    } catch {
      response.status(502).json({ error: 'Release information is unavailable' });
    }
  };
}

module.exports = createLatestReleaseHandler();
module.exports.createLatestReleaseHandler = createLatestReleaseHandler;
