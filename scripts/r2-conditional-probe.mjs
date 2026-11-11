import { createR2Client, validateConfig } from './sync-release-to-r2.mjs';

const config = validateConfig(process.env);
if (!config) throw new Error('R2 configuration is invalid');
const client = createR2Client(config);

async function report(label, response) {
  const body = response.status >= 400 ? (await response.clone().text()).slice(0, 300) : '';
  console.log(`[${label}] status=${response.status} etag=${JSON.stringify(response.headers.get('etag'))} last-modified=${JSON.stringify(response.headers.get('last-modified'))}${body ? ` body=${JSON.stringify(body)}` : ''}`);
  return response;
}

const prefix = 'releases/.conditional-probe';
const keys = [`${prefix}-a.json`, `${prefix}-b.json`, `${prefix}-c.json`];

const latest = await report('latest GET', await client.request('GET', 'releases/latest.json'));
await latest.arrayBuffer();

for (const key of keys) await report(`cleanup ${key}`, await client.request('DELETE', key));

await report('A create if-none-match', await client.request('PUT', keys[0], Buffer.from('{"v":1}'), { 'if-none-match': '*' }));
const a1 = await report('A get1', await client.request('GET', keys[0]));
const a1etag = a1.headers.get('etag');
const a1last = a1.headers.get('last-modified');
await a1.arrayBuffer();
await report('A put if-match as-returned', await client.request('PUT', keys[0], Buffer.from('{"v":2}'), { 'if-match': a1etag }));
const a2 = await report('A get2', await client.request('GET', keys[0]));
const a2etag = a2.headers.get('etag');
await a2.arrayBuffer();
const bare = String(a1etag ?? '').replace(/^W\//, '').replace(/^"|"$/g, '');
await report('A put if-match bare', await client.request('PUT', keys[0], Buffer.from('{"v":3}'), { 'if-match': bare }));
const a3 = await report('A get3', await client.request('GET', keys[0]));
await a3.arrayBuffer();

await report('B create if-none-match', await client.request('PUT', keys[1], Buffer.from('{"v":1}'), { 'if-none-match': '*' }));
const b1 = await report('B get1', await client.request('GET', keys[1]));
const b1last = b1.headers.get('last-modified');
await b1.arrayBuffer();
await report('B put if-unmodified-since', await client.request('PUT', keys[1], Buffer.from('{"v":2}'), { 'if-unmodified-since': b1last }));
const b2 = await report('B get2', await client.request('GET', keys[1]));
await b2.arrayBuffer();

await report('C create if-none-match', await client.request('PUT', keys[2], Buffer.from('{"v":1}'), { 'if-none-match': '*' }));
await report('C put if-none-match again', await client.request('PUT', keys[2], Buffer.from('{"v":2}'), { 'if-none-match': '*' }));

for (const key of keys) await report(`cleanup ${key}`, await client.request('DELETE', key));
