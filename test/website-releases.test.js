const test = require('node:test');
const assert = require('node:assert/strict');
const releases = require('../api/releases');

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

test('release notes endpoint returns and caches the latest five releases', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const data = Array.from({ length: 6 }, (_, index) => ({ tag_name: `v1.0.${index}` }));
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases?per_page=5');
    assert.equal(options.headers['User-Agent'], 'melody-of-oblivion-website');
    return { ok: true, json: async () => data };
  };
  const success = response();
  await releases({}, success);
  assert.equal(success.code, 200);
  assert.equal(success.body.length, 5);
  assert.equal(success.headers['Cache-Control'], 'public, s-maxage=300, stale-while-revalidate=900');
});

test('release notes endpoint reports upstream and malformed responses', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const payload of [{ ok: false }, { ok: true, json: async () => ({ tag_name: 'v1.0.0' }) }]) {
    globalThis.fetch = async () => payload;
    const result = response();
    await releases({}, result);
    assert.equal(result.code, 502);
  }
});
