const test = require('node:test');
const assert = require('node:assert/strict');
const latestRelease = require('../api/latest-release');
const { createLatestReleaseHandler } = latestRelease;

function response() {
  return {
    code: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('latest release API falls back to GitHub before Blob has been populated', async (t) => {
  const originalFetch = globalThis.fetch;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = token;
  });

  const release = { tag_name: 'v1.6.1', assets: [] };
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest');
    return { ok: true, json: async () => release };
  };
  const result = response();
  await latestRelease({}, result);

  assert.equal(result.code, 200);
  assert.equal(result.body.tag_name, 'v1.6.1');
  assert.equal(result.headers['Cache-Control'], 'public, s-maxage=60, stale-while-revalidate=300');
});

const asset = {
  name: 'The-Melody-of-Oblivion-Remake-Windows-x64.exe',
  browser_download_url: 'https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/v1.6.5/launcher.exe',
  size: 100,
  digest: `sha256:${'a'.repeat(64)}`
};

function releaseHandler(github, blob, { githubAvailable = true } = {}) {
  return createLatestReleaseHandler({
    fetchImpl: async (url) => {
      assert.equal(url, 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest');
      return { ok: githubAvailable, json: async () => structuredClone(github) };
    },
    readBlobRelease: async () => blob
  });
}

test('latest release API checks GitHub and discards a stale or backfilled Blob version', async () => {
  const github = { tag_name: 'v1.6.5', body: 'current release notes', assets: [asset] };
  const blob = { tag_name: 'v1.6.4', body: 'old notes', assets: [{ ...asset,
    browser_download_url: 'https://fixture.public.blob.vercel-storage.com/releases/v1.6.4/launcher.exe' }] };
  const result = response();
  await releaseHandler(github, blob)({}, result);
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, github);
});

test('matching Blob assets keep fast download URLs and official metadata', async () => {
  const github = { tag_name: 'v1.6.5', body: 'current release notes', assets: [asset] };
  const blobAsset = { ...asset, browser_download_url: 'https://fixture.public.blob.vercel-storage.com/releases/v1.6.5/launcher.exe' };
  const blob = { tag_name: 'v1.6.5', body: 'old notes', assets: [blobAsset] };
  const result = response();
  await releaseHandler(github, blob)({}, result);
  assert.equal(result.code, 200);
  assert.equal(result.body.body, github.body);
  assert.equal(result.body.assets[0].browser_download_url, blobAsset.browser_download_url);
  assert.equal(result.body.assets[0].github_download_url, asset.browser_download_url);
  assert.equal(result.body.assets[0].digest, asset.digest);
});

test('mismatched Blob bytes never override the official download source', async () => {
  const github = { tag_name: 'v1.6.5', assets: [asset] };
  for (const change of [{ size: 99 }, { size: null }, { digest: null }, { digest: 'sha256:invalid' },
    { digest: `sha256:${'b'.repeat(64)}` },
    { browser_download_url: 'https://untrusted.example/update.exe' }]) {
    const blob = { tag_name: 'v1.6.5', assets: [{ ...asset,
      browser_download_url: 'https://fixture.public.blob.vercel-storage.com/releases/v1.6.5/launcher.exe', ...change }] };
    const result = response();
    await releaseHandler(github, blob)({}, result);
    assert.equal(result.code, 200);
    assert.equal(result.body.assets[0].browser_download_url, asset.browser_download_url);
  }
});

test('Blob digests cannot fill missing or invalid official digests for the same tag and size', async () => {
  for (const digest of [undefined, null, 'sha256:invalid']) {
    const github = { tag_name: 'v1.6.5', assets: [{ ...asset, digest }] };
    const blob = { tag_name: 'v1.6.5', assets: [{ ...asset,
      browser_download_url: 'https://fixture.public.blob.vercel-storage.com/releases/v1.6.5/launcher.exe' }] };
    const result = response();
    await releaseHandler(github, blob)({}, result);
    assert.equal(result.code, 200);
    assert.equal(result.body.assets[0].browser_download_url, asset.browser_download_url);
    assert.equal(result.body.assets[0].digest, null);
  }
});

test('the API verifies official sidecar checksums before accepting Blob download URLs', async () => {
  const sidecar = { name: `${asset.name}.sha256`, browser_download_url: `${asset.browser_download_url}.sha256` };
  for (const blobDigest of [asset.digest, `sha256:${'b'.repeat(64)}`]) {
    const requested = [];
    const handler = createLatestReleaseHandler({
      fetchImpl: async (url) => {
        requested.push(url);
        if (url === sidecar.browser_download_url) {
          return { ok: true, text: async () => `${asset.digest.slice('sha256:'.length)}  ${asset.name}\n` };
        }
        return { ok: true, json: async () => ({ tag_name: 'v1.6.5', assets: [{ ...asset, digest: null }, sidecar] }) };
      },
      readBlobRelease: async () => ({ tag_name: 'v1.6.5', assets: [{ ...asset, digest: blobDigest,
        browser_download_url: 'https://fixture.public.blob.vercel-storage.com/releases/v1.6.5/launcher.exe' }] })
    });
    const result = response();
    await handler({}, result);
    assert.equal(result.code, 200);
    assert.ok(requested.includes(sidecar.browser_download_url));
    assert.equal(result.body.assets[0].digest, asset.digest);
    assert.equal(result.body.assets[0].browser_download_url, blobDigest === asset.digest
      ? 'https://fixture.public.blob.vercel-storage.com/releases/v1.6.5/launcher.exe'
      : asset.browser_download_url);
  }
});

test('GitHub failure does not advertise a Blob manifest with unknown freshness', async () => {
  const result = response();
  await releaseHandler(null, { tag_name: 'v1.6.4', assets: [] }, { githubAvailable: false })({}, result);
  assert.equal(result.code, 502);
  assert.equal(result.headers['Cache-Control'], undefined);
});
