import { createR2Client, validateConfig } from './sync-release-to-r2.mjs';

const config = validateConfig(process.env);
if (!config) throw new Error('R2 configuration is invalid');
const client = createR2Client(config);

async function report(label, response) {
  const body = response.status >= 400 ? (await response.clone().text()).slice(0, 300) : '';
  console.log(`[${label}] status=${response.status} etag=${JSON.stringify(response.headers.get('etag'))} content-encoding=${JSON.stringify(response.headers.get('content-encoding'))} last-modified=${JSON.stringify(response.headers.get('last-modified'))}${body ? ` body=${JSON.stringify(body)}` : ''}`);
  return response;
}

const latest = await report('latest GET default', await client.request('GET', 'releases/latest.json'));
await latest.arrayBuffer();

const identity = await report('latest GET identity', await client.request('GET', 'releases/latest.json', null, { 'accept-encoding': 'identity' }));
const identityEtag = identity.headers.get('etag');
const identityBytes = Buffer.from(await identity.arrayBuffer());

const same = await report('latest PUT same bytes if-match identity', await client.request('PUT', 'releases/latest.json', identityBytes, {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60', 'if-match': identityEtag
}));

const after = await report('latest GET after', await client.request('GET', 'releases/latest.json'));
await after.arrayBuffer();
