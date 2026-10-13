function releaseVersion(release) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/i.exec(String(release?.tag_name ?? '').trim());
  return match ? match.slice(1).map(Number).join('.') : null;
}

function isStableRelease(release) {
  return Boolean(releaseVersion(release)) && Array.isArray(release.assets)
    && release.draft !== true && release.prerelease !== true;
}

function isPublicBlobUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.public.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

// GitHub determines the release; a matching Blob manifest may supply its download URLs.
function withBlobDownloads(release, blobRelease) {
  if (!isStableRelease(blobRelease) || releaseVersion(release) !== releaseVersion(blobRelease)) return release;
  const blobAssets = new Map(blobRelease.assets.map((asset) => [asset.name, asset]));
  return {
    ...release,
    assets: release.assets.map((asset) => {
      const blob = blobAssets.get(asset.name);
      if (!blob || !isPublicBlobUrl(blob.browser_download_url)) return asset;
      const size = Number(asset.size);
      if (!Number.isSafeInteger(size) || size <= 0 || size !== Number(blob.size)) return asset;
      const digest = String(asset.digest ?? '');
      if (!/^sha256:[a-f\d]{64}$/i.test(digest)
        || digest.toLowerCase() !== String(blob.digest ?? '').toLowerCase()) return asset;
      return {
        ...asset,
        browser_download_url: blob.browser_download_url,
        github_download_url: asset.github_download_url || asset.browser_download_url
      };
    })
  };
}

module.exports = { isPublicBlobUrl, isStableRelease, releaseVersion, withBlobDownloads };
