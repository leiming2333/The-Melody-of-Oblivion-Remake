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

const DOWNLOAD_CDN_ORIGIN = 'https://downloads.melodyoblivion.xyz';

function isTrustedCdnUrl(value, tagName, assetName) {
  try {
    const url = new URL(value);
    const expectedPath = `/releases/${encodeURIComponent(tagName)}/${encodeURIComponent(assetName)}`;
    return url.origin === DOWNLOAD_CDN_ORIGIN && url.pathname === expectedPath && !url.search && !url.hash;
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
      const size = Number(asset.size);
      const digest = String(asset.digest ?? '');
      const matchingMetadata = Number.isSafeInteger(size) && size > 0
        && /^sha256:[a-f\d]{64}$/i.test(digest)
        && blob && size === Number(blob.size)
        && digest.toLowerCase() === String(blob.digest ?? '').toLowerCase();
      const next = isTrustedCdnUrl(blob?.cdn_download_url, release.tag_name, asset.name)
        && matchingMetadata
        ? { ...asset, cdn_download_url: blob.cdn_download_url }
        : asset;
      if (!matchingMetadata || !isPublicBlobUrl(blob.browser_download_url)) return next;
      return {
        ...next,
        browser_download_url: blob.browser_download_url,
        github_download_url: asset.github_download_url || asset.browser_download_url
      };
    })
  };
}

module.exports = { isPublicBlobUrl, isStableRelease, isTrustedCdnUrl, releaseVersion, withBlobDownloads };
