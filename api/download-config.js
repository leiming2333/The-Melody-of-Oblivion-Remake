const websiteCdnConfig = require('../src/shared/website-cdn-config.json');
const ACTION = 'download';

function readDownloadConfig(env = process.env) {
  const siteKey = String(env.TURNSTILE_SITE_KEY ?? '').trim();
  const turnstileSecret = String(env.TURNSTILE_SECRET_KEY ?? '').trim();
  // The API and Worker must use exactly the same bytes. Do not trim this secret.
  const authSecret = env.DOWNLOAD_AUTH_SECRET;
  const baseValue = env.DOWNLOAD_CDN_BASE_URL ?? websiteCdnConfig.baseUrl;
  let baseUrl;
  try {
    const base = new URL(baseValue);
    baseUrl = `${base.origin}${base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')}`;
    if (base.protocol !== 'https:' || base.username || base.password || base.port || base.search || base.hash
      || !websiteCdnConfig.allowedBases.includes(baseUrl)
      || ![baseUrl, `${baseUrl}/`].includes(baseValue)) return null;
  } catch { return null; }
  const hostnames = String(env.DOWNLOAD_ALLOWED_HOSTNAMES ?? '').split(',')
    .map(value => value.trim().toLowerCase()).filter(Boolean);
  const ttl = env.DOWNLOAD_URL_TTL_SECONDS === undefined
    ? 900 : Number(env.DOWNLOAD_URL_TTL_SECONDS);
  const validHostname = value => /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(value);
  // Cloudflare's published test keys must never enable a production download gate.
  const testKey = value => /^\d+x0{10,}/i.test(value);
  if (!siteKey || !turnstileSecret || testKey(siteKey) || testKey(turnstileSecret)
    || typeof authSecret !== 'string' || Buffer.byteLength(authSecret, 'utf8') < 32 || authSecret.length > 4096
    || !hostnames.length || hostnames.some(hostname => !validHostname(hostname))
    || !Number.isInteger(ttl) || ttl < 60 || ttl > 3600) return null;
  return { siteKey, turnstileSecret, authSecret, baseUrl, hostnames: new Set(hostnames), ttl, action: ACTION };
}

function publicDownloadConfig(env = process.env) {
  const config = readDownloadConfig(env);
  return { enabled: Boolean(config), siteKey: config?.siteKey ?? null, action: ACTION, baseUrl: config?.baseUrl ?? null };
}

function createDownloadConfigHandler({ env = process.env } = {}) {
  return function downloadConfig(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      return response.status(405).json({ code: 'METHOD_NOT_ALLOWED', error: 'Use GET to read download configuration' });
    }
    return response.status(200).json(publicDownloadConfig(env));
  };
}

module.exports = createDownloadConfigHandler();
module.exports.createDownloadConfigHandler = createDownloadConfigHandler;
module.exports.publicDownloadConfig = publicDownloadConfig;
module.exports.readDownloadConfig = readDownloadConfig;
