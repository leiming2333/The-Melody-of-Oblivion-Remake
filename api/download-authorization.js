const { createHmac } = require('node:crypto');
const websiteCdnConfig = require('../src/shared/website-cdn-config.json');

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const ACTION = 'download';
const ASSETS = new Set([
  'The-Melody-of-Oblivion-Remake-Windows-x64.exe',
  'The-Melody-of-Oblivion-Remake-Windows-ia32.exe',
  'The-Melody-of-Oblivion-Remake-Windows-arm64.exe',
  'The-Melody-of-Oblivion-Remake-Linux-x64.AppImage',
  'The-Melody-of-Oblivion-Remake-Linux-arm64.AppImage',
  'The-Melody-of-Oblivion-Remake-Linux-armv7l.AppImage',
  'The-Melody-of-Oblivion-Remake-macOS-x64.zip',
  'The-Melody-of-Oblivion-Remake-macOS-arm64.zip'
]);

function readDownloadConfig(env = process.env) {
  const siteKey = String(env.TURNSTILE_SITE_KEY ?? '').trim();
  const turnstileSecret = String(env.TURNSTILE_SECRET_KEY ?? '').trim();
  // The API and Worker use these exact UTF-8 bytes; do not trim one side's key.
  const authSecret = env.DOWNLOAD_AUTH_SECRET;
  let base;
  try {
    base = new URL(env.DOWNLOAD_CDN_BASE_URL ?? websiteCdnConfig.baseUrl);
    // Keep this allowlist aligned with the browser's signed-URL validator.
    if (base.protocol !== 'https:' || base.hostname !== 'downloads.melodyoblivion.xyz'
      || base.username || base.password || base.port
      || base.pathname !== '/' || base.search || base.hash) return null;
  } catch { return null; }
  const hostnames = String(env.DOWNLOAD_ALLOWED_HOSTNAMES ?? '').split(',')
    .map(value => value.trim().toLowerCase()).filter(Boolean);
  const ttl = env.DOWNLOAD_URL_TTL_SECONDS === undefined ? 900 : Number(env.DOWNLOAD_URL_TTL_SECONDS);
  // Cloudflare's published test keys must never turn a production gate into an always-pass gate.
  const testKey = value => /^\d+x0{10,}/i.test(value);
  if (!siteKey || !turnstileSecret || testKey(siteKey) || testKey(turnstileSecret)
    || typeof authSecret !== 'string' || Buffer.byteLength(authSecret, 'utf8') < 32 || authSecret.length > 4096
    || !hostnames.length || hostnames.some(hostname =>
      !/^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(hostname))
    || !Number.isInteger(ttl) || ttl < 60 || ttl > 3600) return null;
  return { siteKey, turnstileSecret, authSecret, baseUrl: base.origin,
    hostnames: new Set(hostnames), ttl, action: ACTION };
}

function publicDownloadConfig(env = process.env) {
  const config = readDownloadConfig(env);
  return { enabled: Boolean(config), siteKey: config?.siteKey ?? null, action: ACTION };
}

// The permit is scoped to one immutable asset and reusable only until expiry,
// allowing the website's parallel Range requests to share one Turnstile check.
function signDownload(config, tag, asset, now = new Date()) {
  const pathname = `/releases/${tag}/${asset}`;
  const expires = Math.floor(now.getTime() / 1000) + config.ttl;
  const signature = createHmac('sha256', config.authSecret)
    .update(`download-v1\n${pathname}\n${expires}`, 'utf8').digest('base64url');
  return {
    url: `${config.baseUrl}${pathname}?expires=${expires}&signature=${signature}`,
    expiresAt: new Date(expires * 1000).toISOString()
  };
}

function allowedOrigin(request, config) {
  try {
    const value = request.headers?.origin;
    if (typeof value !== 'string') return false;
    const origin = new URL(value);
    return origin.protocol === 'https:' && !origin.username && !origin.password
      && !origin.port && value === origin.origin && config.hostnames.has(origin.hostname);
  } catch { return false; }
}

function parseBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers?.['content-type'] ?? '')) return null;
  let body = request.body;
  if (typeof body === 'string') {
    if (body.length > 4096) return null;
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['tag', 'asset', 'turnstileToken'].includes(key))) return null;
  const { tag, asset, turnstileToken } = body;
  if (typeof tag !== 'string' || tag.length > 32 || !/^v\d+\.\d+\.\d+$/.test(tag)
    || typeof asset !== 'string' || !ASSETS.has(asset)
    || typeof turnstileToken !== 'string' || !turnstileToken.trim() || turnstileToken.length > 2048) return null;
  return { tag, asset, turnstileToken };
}

function createDownloadAuthorizationHandler({
  env = process.env, fetchImpl = (...args) => fetch(...args), now = () => new Date()
} = {}) {
  return async function downloadAuthorization(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const fail = (status, code, error) => response.status(status).json({ code, error });
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return fail(405, 'METHOD_NOT_ALLOWED', 'Use POST to authorize a download');
    }
    const config = readDownloadConfig(env);
    if (!config) return fail(503, 'DOWNLOAD_NOT_CONFIGURED', 'Verified downloads are not configured');
    if (!allowedOrigin(request, config)) return fail(403, 'INVALID_ORIGIN', 'Download origin is not allowed');
    const body = parseBody(request);
    if (!body) return fail(400, 'INVALID_DOWNLOAD_REQUEST', 'A valid release asset and human verification are required');
    let verification;
    try {
      const result = await fetchImpl(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: config.turnstileSecret, response: body.turnstileToken }),
        signal: AbortSignal.timeout(8000)
      });
      if (!result.ok) throw new Error('Verification service unavailable');
      verification = await result.json();
    } catch {
      return fail(502, 'VERIFICATION_UNAVAILABLE', 'Human verification is temporarily unavailable');
    }
    if (verification?.success !== true || verification.action !== ACTION
      || typeof verification.hostname !== 'string' || !config.hostnames.has(verification.hostname.toLowerCase())) {
      return fail(403, 'VERIFICATION_FAILED', 'Human verification failed or expired; please verify again');
    }
    try {
      return response.status(200).json(signDownload(config, body.tag, body.asset, now()));
    } catch {
      return fail(503, 'DOWNLOAD_UNAVAILABLE', 'Download authorization is temporarily unavailable');
    }
  };
}

module.exports = createDownloadAuthorizationHandler();
module.exports.createDownloadAuthorizationHandler = createDownloadAuthorizationHandler;
module.exports.publicDownloadConfig = publicDownloadConfig;
module.exports.signDownload = signDownload;
module.exports.readDownloadConfig = readDownloadConfig;
