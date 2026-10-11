const ASSET_NAME = /^The-Melody-of-Oblivion-Remake-(?:v(\d+\.\d+\.\d+)-)?(?:Windows-(?:Setup-)?(?:x64|ia32|arm64)\.exe|Windows-(?:x64|ia32|arm64)\.zip|Linux-(?:x64|arm64|armv7l)\.AppImage|macOS-(?:x64|arm64)\.zip)$/;

async function findBlob(pathname) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: pathname, limit: 10 });
    return blobs.find((blob) => blob.pathname === pathname && isPublicBlobUrl(blob.url)) ?? null;
  } catch {
    return null;
  }
}

function isPublicBlobUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.public.blob.vercel-storage.com');
  } catch {
    return false;
  }
}

module.exports = async function download(request, response) {
  const { tag, asset, source = 'official' } = request.query ?? {};
  const mirrors = new Map([
    ['official', ''],
    ['ghproxy', 'https://ghproxy.net/'],
    ['ghfast', 'https://ghfast.top/'],
    ['gh-proxy', 'https://gh-proxy.com/']
  ]);
  const match = typeof asset === 'string' ? ASSET_NAME.exec(asset) : null;
  if (!match || typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)
    || (match[1] && tag !== `v${match[1]}`) || (!mirrors.has(source) && source !== 'blob')) {
    response.status(400).json({ error: 'Invalid release asset' });
    return;
  }

  const destination = `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
  if (source === 'blob') {
    const blob = await findBlob(`releases/${tag}/${asset}`);
    if (blob) {
      response.setHeader('Cache-Control', 'public, max-age=300');
      response.redirect(302, blob.url);
      return;
    }
  }
  response.setHeader('Cache-Control', 'public, max-age=300');
  response.redirect(302, `${mirrors.get(source) ?? ''}${destination}`);
};
