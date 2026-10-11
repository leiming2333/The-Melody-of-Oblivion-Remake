const test = require('node:test');
const assert = require('node:assert/strict');
const latestRelease = require('../api/latest-release');

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
