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
    return url.protocol === 'https:' && url.hostname.endsWith('.public.blob.vercel-storage.com')
      && !url.username && !url.password && !url.port && !url.hash;
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
  const officialAssets = release.assets.map(({ cdn_download_url: _legacyCdn, ...asset }) => asset);
  const officialRelease = { ...release, assets: officialAssets };
  if (!isStableRelease(blobRelease) || releaseVersion(release) !== releaseVersion(blobRelease)) return officialRelease;
  const blobAssets = new Map();
  const duplicates = new Set();
  for (const asset of blobRelease.assets) {
    if (!asset || typeof asset.name !== 'string') continue;
    if (blobAssets.has(asset.name)) duplicates.add(asset.name);
    blobAssets.set(asset.name, asset);
  }
  return {
    ...officialRelease,
    assets: officialAssets.map((asset) => {
      const blob = blobAssets.get(asset.name);
      const size = Number(asset.size);
      const digest = String(asset.digest ?? '');
      const matchingMetadata = Number.isSafeInteger(size) && size > 0
        && /^sha256:[a-f\d]{64}$/i.test(digest)
        && blob && !duplicates.has(asset.name) && size === Number(blob.size)
        && digest.toLowerCase() === String(blob.digest ?? '').toLowerCase();
      if (!matchingMetadata || !isPublicBlobUrl(blob.browser_download_url)) return asset;
      return {
        ...asset,
        browser_download_url: blob.browser_download_url,
        github_download_url: asset.github_download_url || asset.browser_download_url
      };
    })
  };
}

function objectStorageBase(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && url.pathname === '/' && !url.search && !url.hash
      && (value === url.origin || value === `${url.origin}/`) ? url.origin : null;
  } catch { return null; }
}

function isTrustedObjectStorageUrl(value, baseUrl, tagName, assetName) {
  try {
    const base = objectStorageBase(baseUrl);
    if (!base || !/^v\d+\.\d+\.\d+$/.test(tagName ?? '') || typeof assetName !== 'string'
      || !assetName || /[\\/\u0000-\u001f]/.test(assetName)) return false;
    return value === `${base}/releases/${encodeURIComponent(tagName)}/${encodeURIComponent(assetName)}`;
  } catch { return false; }
}

function withObjectStorageDownloads(release, objectRelease, baseUrl) {
  const assets = release.assets.map(({ object_storage_download_url: _oldUrl, object_storage_verified: _oldVerification, ...asset }) => asset);
  const clean = { ...release, assets };
  if (!objectStorageBase(baseUrl) || !isStableRelease(objectRelease)
    || release.tag_name !== objectRelease.tag_name) return clean;
  const candidates = new Map();
  const duplicates = new Set();
  for (const asset of objectRelease.assets) {
    if (!asset || typeof asset.name !== 'string') continue;
    if (candidates.has(asset.name)) duplicates.add(asset.name);
    candidates.set(asset.name, asset);
  }
  return { ...clean, assets: assets.map(asset => {
    const candidate = candidates.get(asset.name);
    if (!candidate || candidate.object_storage_verified !== true || duplicates.has(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || asset.size !== candidate.size || !/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '')
      || String(asset.digest).toLowerCase() !== String(candidate.digest ?? '').toLowerCase()
      || !isTrustedObjectStorageUrl(candidate.object_storage_download_url, baseUrl, release.tag_name, asset.name)) return asset;
    return { ...asset, object_storage_download_url: candidate.object_storage_download_url, object_storage_verified: true };
  }) };
}

module.exports = { isPublicBlobUrl, isStableRelease, isTrustedCdnUrl, releaseVersion, withBlobDownloads,
  objectStorageBase, isTrustedObjectStorageUrl, withObjectStorageDownloads };
