const ASSET_NAME = /^The-Melody-of-Oblivion-Remake-(?:v(\d+\.\d+\.\d+)-)?(?:Windows-(?:Setup-)?(?:x64|ia32|arm64)\.exe|Windows-(?:x64|ia32|arm64)\.zip|Linux-(?:x64|arm64|armv7l)\.AppImage|macOS-(?:x64|arm64)\.zip)$/;

module.exports = function download(request, response) {
  const { tag, asset, source = 'official' } = request.query ?? {};
  const mirrors = new Map([
    ['official', ''],
    ['ghproxy', 'https://ghproxy.net/'],
    ['ghfast', 'https://ghfast.top/'],
    ['gh-proxy', 'https://gh-proxy.com/']
  ]);
  const match = typeof asset === 'string' ? ASSET_NAME.exec(asset) : null;
  if (!match || typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)
    || (match[1] && tag !== `v${match[1]}`) || !mirrors.has(source)) {
    response.status(400).json({ error: 'Invalid release asset' });
    return;
  }

  const destination = `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
  response.setHeader('Cache-Control', 'public, max-age=300');
  response.redirect(302, `${mirrors.get(source)}${destination}`);
};
