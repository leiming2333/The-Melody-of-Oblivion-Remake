const RELEASE_API = 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest';

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

async function readChecksum(asset) {
  const sidecar = asset.checksumAsset;
  if (!sidecar?.browser_download_url?.startsWith('https://github.com/')) return null;
  try {
    const response = await fetch(sidecar.browser_download_url, {
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

module.exports = async function latestRelease(_request, response) {
  try {
    const blobRelease = await latestBlobRelease();
    if (blobRelease) {
      response.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      response.status(200).json(blobRelease);
      return;
    }
    const upstream = await fetch(RELEASE_API, {
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
    if (Array.isArray(release.assets)) {
      const checksumAssets = new Map(release.assets
        .filter((asset) => asset.name?.endsWith('.sha256'))
        .map((asset) => [asset.name.slice(0, -'.sha256'.length), asset]));
      await Promise.all(release.assets.map(async (asset) => {
        if (!asset.name || !/\.(?:exe|zip|AppImage)$/i.test(asset.name)) return;
        if (!/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? "")) {
          asset.digest = await readChecksum({ ...asset, checksumAsset: checksumAssets.get(asset.name) });
        }
      }));
    }
    response.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    response.status(200).json(release);
  } catch {
    response.status(502).json({ error: 'Release information is unavailable' });
  }
};
