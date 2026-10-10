const test = require('node:test');
const assert = require('node:assert/strict');
const download = require('../api/download');

function request(source, asset = 'The-Melody-of-Oblivion-Remake-v1.5.1-Windows-x64.exe', tag = 'v1.5.1') {
  const result = {};
  download({ query: { tag, asset, source } }, {
    setHeader() {},
    status(code) { result.code = code; return this; },
    json(body) { result.body = body; },
    redirect(code, url) { result.code = code; result.url = url; }
  });
  return result;
}

test('website downloads use the selected mirror and preserve official fallback', () => {
  const official = request(undefined);
  assert.equal(official.code, 302);
  assert.ok(official.url.startsWith('https://github.com/leiming2333/'));
  for (const [source, host] of [['ghproxy', 'ghproxy.net'], ['ghfast', 'ghfast.top'], ['gh-proxy', 'gh-proxy.com']]) {
    assert.equal(request(source).url, `https://${host}/${official.url}`);
  }
  assert.equal(request('https://example.com').code, 400);
  assert.equal(request(['ghproxy']).code, 400);
});

test('versionless assets work while invalid tags and mismatched legacy versions are rejected', () => {
  assert.equal(request(undefined, 'The-Melody-of-Oblivion-Remake-Windows-x64.exe').code, 302);
  assert.equal(request(undefined, 'The-Melody-of-Oblivion-Remake-Linux-x64.AppImage').code, 302);
  assert.equal(request(undefined, 'The-Melody-of-Oblivion-Remake-macOS-arm64.zip').code, 302);
  assert.equal(request(undefined, 'The-Melody-of-Oblivion-Remake-Windows-x64.exe', '../bad').code, 400);
  assert.equal(request(undefined, '../The-Melody-of-Oblivion-Remake-Windows-x64.exe').code, 400);
  assert.equal(request(undefined, 'The-Melody-of-Oblivion-Remake-v1.5.2-Windows-x64.exe').code, 400);
});
