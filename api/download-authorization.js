const { createHmac } = require('node:crypto');
const { readDownloadConfig } = require('./download-config');

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

function createDownloadTarget(config, tag, asset, now = new Date()) {
  const expires = Math.floor(now.getTime() / 1000) + config.ttl;
  const url = new URL(`${config.baseUrl}/releases/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`);
  const signature = createHmac('sha256', config.authSecret)
    .update(`download-v1\n${url.pathname}\n${expires}`, 'utf8').digest('base64url');
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('signature', signature);
  return { url: url.href, expiresAt: new Date(expires * 1000).toISOString() };
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
      return response.status(200).json(createDownloadTarget(config, body.tag, body.asset, now()));
    } catch {
      return fail(503, 'DOWNLOAD_UNAVAILABLE', 'Download authorization is temporarily unavailable');
    }
  };
}

module.exports = createDownloadAuthorizationHandler();
module.exports.createDownloadAuthorizationHandler = createDownloadAuthorizationHandler;
module.exports.createDownloadTarget = createDownloadTarget;
module.exports.signDownload = createDownloadTarget;
module.exports.parseBody = parseBody;
module.exports.readDownloadConfig = readDownloadConfig;
