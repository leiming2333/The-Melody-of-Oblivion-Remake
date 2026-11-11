import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import releaseAssets from './release-assets.cjs';

const { assertTag, verifyManifest, verifyPatchManifest } = releaseAssets;
const PATCH_MANIFEST_NAME = 'patch-manifest.json';
const SERVICE = 's3';
const REGION = 'auto';
const EMPTY_HASH = createHash('sha256').update('').digest('hex');

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sign(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function signingKey(secret, date) {
  return sign(sign(sign(sign(`AWS4${secret}`, date), REGION), SERVICE), 'aws4_request');
}

function configValidation(env) {
  const text = name => typeof env[name] === 'string' ? env[name].trim() : '';
  const accountId = text('R2_ACCOUNT_ID');
  const bucket = text('R2_BUCKET_NAME');
  const accessKeyId = text('R2_ACCESS_KEY_ID');
  const secretAccessKey = text('R2_SECRET_ACCESS_KEY');
  const publicBaseText = text('R2_PUBLIC_BASE_URL');
  const invalidFields = [];
  if (!/^[a-f\d]{32}$/i.test(accountId)) invalidFields.push('R2_ACCOUNT_ID');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) invalidFields.push('R2_BUCKET_NAME');
  if (!/^[A-Za-z\d_-]{8,128}$/.test(accessKeyId)) invalidFields.push('R2_ACCESS_KEY_ID');
  if (Buffer.byteLength(secretAccessKey, 'utf8') < 16 || secretAccessKey.length > 256) {
    invalidFields.push('R2_SECRET_ACCESS_KEY');
  }
  let publicBase;
  try {
    publicBase = new URL(publicBaseText);
    if (publicBase.protocol !== 'https:' || publicBase.username || publicBase.password
      || publicBase.port || publicBase.pathname !== '/' || publicBase.search || publicBase.hash
      || ![publicBase.origin, `${publicBase.origin}/`].includes(publicBaseText)) invalidFields.push('R2_PUBLIC_BASE_URL');
  } catch { invalidFields.push('R2_PUBLIC_BASE_URL'); }
  return { invalidFields, config: invalidFields.length ? null
    : { accountId, bucket, accessKeyId, secretAccessKey, publicBase: publicBase.origin } };
}

export function validateConfig(env = process.env) {
  return configValidation(env).config;
}

function objectUrl(config, pathname) {
  return `${config.publicBase}/${pathname.split('/').map(encode).join('/')}`;
}

function safeNetworkError(error, config) {
  const source = error?.cause && typeof error.cause === 'object' ? error.cause : error;
  const code = typeof source?.code === 'string' ? source.code : '';
  const message = typeof source?.message === 'string' ? source.message : '';
  const details = [code, message].filter(Boolean).join(': ') || 'network-error';
  return [config?.accessKeyId, config?.secretAccessKey].filter(value => typeof value === 'string' && value.length > 0)
    .reduce((result, value) => result.replaceAll(value, '[redacted]'), details);
}

async function s3ErrorCode(response) {
  try {
    const body = await response.clone().text();
    return body.match(/<Code>\s*([A-Za-z0-9_.-]{1,80})\s*<\/Code>/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function createR2Client(config, fetchImpl = fetch, now = () => new Date()) {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const endpoint = pathname => `https://${host}/${config.bucket}/${pathname.split('/').map(encode).join('/')}`;
  async function request(method, pathname, body = null, extraHeaders = {}) {
    const payloadHash = body === null ? EMPTY_HASH : createHash('sha256').update(body).digest('hex');
    const date = now();
    const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDate = amzDate.slice(0, 8);
    const url = endpoint(pathname);
    const parsed = new URL(url);
    const headers = {
      host: parsed.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders
    };
    const canonicalHeaders = Object.keys(headers).map(name => name.toLowerCase()).sort()
      .map(name => `${name}:${String(headers[Object.keys(headers).find(key => key.toLowerCase() === name)]).trim().replace(/\s+/g, ' ')}\n`).join('');
    const signedHeaders = Object.keys(headers).map(name => name.toLowerCase()).sort().join(';');
    const canonicalRequest = [method, parsed.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${shortDate}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
      createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
    const signature = createHmac('sha256', signingKey(config.secretAccessKey, shortDate))
      .update(stringToSign, 'utf8').digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const requestHeaders = { ...headers, Authorization: authorization };
    delete requestHeaders.host;
    let response;
    try {
      response = await fetchImpl(url, { method, headers: requestHeaders, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120000) });
    } catch (error) {
      throw new Error(`R2 request failed: ${method} ${parsed.host}${parsed.pathname}: ${safeNetworkError(error, config)}`, { cause: error });
    }
    if (response.status === 401 || response.status === 403) {
      const code = await s3ErrorCode(response);
      throw new Error(`R2 request rejected: ${method} ${parsed.host}${parsed.pathname} (HTTP ${response.status}${code ? `, Code=${safeNetworkError({ message: code }, config)}` : ''})`);
    }
    return response;
  }
  return { request };
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`Cannot read existing R2 ${label}`);
  try { return await response.json(); } catch { throw new Error(`Invalid existing R2 ${label}`); }
}

async function publicVerify(config, fetchImpl, pathname, expected) {
  const url = objectUrl(config, pathname);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET', headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(120000)
    });
  } catch (error) {
    const parsed = new URL(url);
    throw new Error(`R2 public request failed: GET ${parsed.host}${parsed.pathname}: ${safeNetworkError(error, config)}`, { cause: error });
  }
  await verifyResponse(response, expected, `public ${pathname}`);
}

async function verifyResponse(response, expected, label) {
  if (!response.ok || !response.body) throw new Error(`R2 read failed: ${label}`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.length;
    if (size > expected.size) throw new Error(`R2 digest mismatch: ${expected.name ?? label}`);
  }
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
    throw new Error(`R2 digest mismatch: ${expected.name ?? label}`);
  }
}

export async function syncReleaseToR2(assetDirectory, tag, metadataPath, {
  env = process.env, fetchImpl = fetch, now = () => new Date()
} = {}) {
  const { config, invalidFields } = configValidation(env);
  if (!config) throw new Error(`Invalid R2 configuration fields: ${invalidFields.join(', ')}. Check their format or missing values.`);
  const manifest = JSON.parse(await readFile(path.join(assetDirectory, 'release-manifest.json'), 'utf8'));
  assertTag(tag, manifest.version);
  const packages = await verifyManifest(assetDirectory, manifest);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.tagName !== tag) throw new Error('GitHub release metadata does not match the requested tag');
  const client = createR2Client(config, fetchImpl, now);
  const manifestPath = `releases/${tag}/manifest.json`;
  const existingManifestResponse = await client.request('GET', manifestPath);
  let existingManifest = null;
  if (existingManifestResponse.status === 200) existingManifest = await readJson(existingManifestResponse, `manifest ${tag}`);
  else if (existingManifestResponse.status !== 404) {
    throw new Error(`Cannot inspect existing R2 manifest: ${tag} (HTTP ${existingManifestResponse.status})`);
  }
  if (existingManifest && !isDeepStrictEqual(existingManifest, manifest)) {
    throw new Error('Published R2 tag is immutable; use a new version');
  }
  async function uploadVerified(pathname, body, expected, contentType) {
    const head = await client.request('HEAD', pathname);
    let existingObject = head.status === 200;
    if (head.status === 404) {
      const put = await client.request('PUT', pathname, body, {
        'if-none-match': '*', 'content-type': contentType,
        'content-disposition': `attachment; filename="${expected.name}"`,
        'cache-control': 'public, max-age=31536000, immutable'
      });
      if (![200, 201, 204, 412].includes(put.status)) throw new Error(`R2 upload failed: ${expected.name}`);
      existingObject = put.status === 412;
    } else if (head.status !== 200) {
      throw new Error(`Cannot inspect existing R2 object: ${expected.name} (HTTP ${head.status})`);
    }
    if (existingObject) await verifyResponse(await client.request('GET', pathname), expected, `origin ${pathname}`);
    await publicVerify(config, fetchImpl, pathname, expected);
  }

  const assets = [];
  for (const item of packages) {
    const pathname = `releases/${tag}/${item.name}`;
    const head = await client.request('HEAD', pathname);
    let existingObject = head.status === 200;
    if (head.status === 404) {
      const body = await readFile(item.file);
      const put = await client.request('PUT', pathname, body, {
        'if-none-match': '*', 'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${item.name}"`,
        'cache-control': 'public, max-age=31536000, immutable'
      });
      if (![200, 201, 204, 412].includes(put.status)) throw new Error(`R2 upload failed: ${item.name}`);
      existingObject = put.status === 412;
    } else if (head.status !== 200) {
      throw new Error(`Cannot inspect existing R2 object: ${item.name} (HTTP ${head.status})`);
    }
    // The custom domain may still cache old bytes; inspect the origin for an existing immutable key.
    if (existingObject) await verifyResponse(await client.request('GET', pathname), item, `origin ${pathname}`);
    await publicVerify(config, fetchImpl, pathname, item);
    assets.push({ name: item.name, size: item.size,
      platform: `${{ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[item.target.platform]}-${item.target.arch}`,
      digest: `sha256:${item.sha256}`, object_storage_download_url: objectUrl(config, pathname),
      object_storage_verified: true,
      github_download_url: `https://github.com/${env.GITHUB_REPOSITORY || 'leiming2333/The-Melody-of-Oblivion-Remake'}/releases/download/${encode(tag)}/${encode(item.name)}` });
  }
  const patchManifest = await verifyPatchManifest(assetDirectory, manifest);
  let patchCount = 0;
  if (patchManifest) {
    for (const patch of patchManifest.patches) {
      patchCount += 1;
      await uploadVerified(`patches/${tag}/${patch.name}`,
        await readFile(path.join(assetDirectory, patch.name)), patch, 'application/octet-stream');
    }
    const patchManifestPath = path.join(assetDirectory, PATCH_MANIFEST_NAME);
    const patchManifestBytes = await readFile(patchManifestPath);
    await uploadVerified(`patches/${tag}/${PATCH_MANIFEST_NAME}`, patchManifestBytes,
      { name: PATCH_MANIFEST_NAME, size: patchManifestBytes.length,
        sha256: createHash('sha256').update(patchManifestBytes).digest('hex') },
      'application/json; charset=utf-8');
  }
  if (!existingManifest) {
    const putManifest = await client.request('PUT', manifestPath, Buffer.from(JSON.stringify(manifest)), {
      'if-none-match': '*', 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable'
    });
    if (![200, 201, 204, 412].includes(putManifest.status)) {
      throw new Error(`R2 manifest upload failed: ${tag} (HTTP ${putManifest.status})`);
    }
    if (putManifest.status === 412) {
      const concurrent = await readJson(await client.request('GET', manifestPath), `manifest ${tag}`);
      if (!isDeepStrictEqual(concurrent, manifest)) throw new Error('Published R2 tag is immutable; use a new version');
    }
  }
  const latestPath = 'releases/latest.json';
  const release = { tag_name: tag, name: metadata.name || tag,
    html_url: metadata.url || `https://github.com/${env.GITHUB_REPOSITORY || 'leiming2333/The-Melody-of-Oblivion-Remake'}/releases/tag/${encode(tag)}`,
    body: metadata.body || '', published_at: metadata.publishedAt || null, assets };
  for (let attempt = 0; attempt < 3; attempt++) {
    // R2 returns a weak ETag for gzip-compressed responses; If-Match needs a strong ETag.
    const latestResponse = await client.request('GET', latestPath, null, { 'accept-encoding': 'identity' });
    let latest = null;
    if (latestResponse.status === 200) latest = await readJson(latestResponse, 'latest metadata');
    else if (latestResponse.status !== 404) {
      throw new Error(`Cannot inspect existing R2 latest metadata (HTTP ${latestResponse.status})`);
    }
    if (latest?.tag_name && newerVersion(latest.tag_name, tag)) {
      return { tag, assets, patches: patchCount, latestUpdated: false };
    }
    const etag = latestResponse.headers.get('etag');
    if (latestResponse.status === 200 && !etag) throw new Error('R2 latest metadata has no conditional-write ETag');
    const putLatest = await client.request('PUT', latestPath, Buffer.from(JSON.stringify(release)), {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60',
      ...(etag ? { 'if-match': etag } : { 'if-none-match': '*' })
    });
    if ([200, 201, 204].includes(putLatest.status)) return { ...release, patches: patchCount, latestUpdated: true };
    if (putLatest.status !== 412) {
      throw new Error(`R2 latest metadata upload failed (HTTP ${putLatest.status})`);
    }
  }
  throw new Error('R2 latest metadata changed concurrently; retry synchronization');
}

function newerVersion(left, right) {
  const a = String(left).replace(/^v/, '').split('.').map(Number);
  const b = String(right).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [assetDirectory, tag, metadataPath] = process.argv.slice(2);
  syncReleaseToR2(assetDirectory, tag, metadataPath)
    .then(result => console.log(`Verified ${result.assets.length} R2 packages and ${result.patches} patches for ${tag}; latest updated: ${result.latestUpdated}.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
