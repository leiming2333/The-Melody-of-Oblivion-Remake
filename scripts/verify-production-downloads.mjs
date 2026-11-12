import { createHmac } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { resolve4, resolve6 } from 'node:dns/promises';

// Some Windows resolvers return a stale negative getaddrinfo result while the
// authoritative A records are already available. Query the records directly.
setDefaultResultOrder('ipv4first');

const site = process.env.DOWNLOAD_SITE_URL ?? 'https://www.melodyoblivion.xyz';
const allowedBases = new Set([
  'https://verified-downloads.melodyoblivion.xyz',
  'https://www.melodyoblivion.xyz/verified-downloads',
  'https://melodyoblivion.xyz/verified-downloads'
]);

function fail(message) {
  throw new Error(message);
}

async function json(path) {
  const response = await fetch(new URL(path, site), {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) fail(`${path} returned HTTP ${response.status}`);
  return response.json();
}

const config = await json('/api/download-config');
if (config?.enabled !== true || !allowedBases.has(config.baseUrl)) {
  fail('Download configuration is disabled or uses an unrecognized base URL');
}
const baseUrl = config.baseUrl;
const hostname = new URL(baseUrl).hostname;
const addresses = await resolve4(hostname).catch(() => resolve6(hostname).catch(() => []));
if (!addresses.length) fail(`DNS did not resolve ${hostname}`);

const release = await json('/api/latest-release');
const tag = release?.tag_name;
const asset = release?.assets?.find(item => item?.name === 'The-Melody-of-Oblivion-Remake-Windows-x64.exe');
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !asset?.size || !/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? '')) {
  fail('Latest release is missing a trusted Windows x64 asset');
}

const objectPath = `/releases/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
const objectUrl = `${baseUrl}${objectPath}`;
const preflight = await fetch(objectUrl, {
  method: 'OPTIONS',
  headers: {
    Origin: site, 'Access-Control-Request-Method': 'GET',
    'Access-Control-Request-Headers': 'range'
  },
  signal: AbortSignal.timeout(15000)
});
if (preflight.status !== 204 || !preflight.headers.get('access-control-allow-origin')) {
  fail('CORS preflight failed');
}

const unsigned = await fetch(objectUrl, {
  headers: { Origin: site, Range: 'bytes=0-1023' },
  signal: AbortSignal.timeout(15000)
});
if (unsigned.status !== 403) {
  fail(`Unsigned download returned HTTP ${unsigned.status}; expected 403`);
}

const secret = process.env.DOWNLOAD_AUTH_SECRET;
if (!secret) {
  console.log('PRODUCTION_DOWNLOAD_OK (unsigned gate verified; set DOWNLOAD_AUTH_SECRET for the signed check)');
  process.exit(0);
}

const expires = Math.floor(Date.now() / 1000) + 600;
const signature = createHmac('sha256', secret)
  .update(`download-v1\n${objectPath}\n${expires}`).digest('base64url');
const signedUrl = new URL(objectUrl);
signedUrl.searchParams.set('expires', String(expires));
signedUrl.searchParams.set('signature', signature);
const signed = await fetch(signedUrl, {
  headers: { Origin: site, Range: 'bytes=0-1023' },
  signal: AbortSignal.timeout(30000)
});
const expectedRange = `bytes 0-1023/${asset.size}`;
const bytes = Buffer.from(await signed.arrayBuffer());
if (signed.status !== 206 || signed.headers.get('content-range') !== expectedRange
  || signed.headers.get('content-length') !== '1024' || bytes.length !== 1024) {
  fail(`Signed range failed: HTTP ${signed.status}, Content-Range ${signed.headers.get('content-range')}`);
}
console.log(`PRODUCTION_DOWNLOAD_OK ${tag} ${signed.headers.get('x-melody-source') ?? ''}`.trim());
