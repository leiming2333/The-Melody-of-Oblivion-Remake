const test = require('node:test');
const assert = require('node:assert/strict');
const latestRelease = require('../api/latest-release');
const download = require('../api/download');

function response() {
  return {
    code: null,
    headers: {},
    body: null,
    destination: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(code, destination) { this.code = code; this.destination = destination; return this; }
  };
}

test('Setup and ZIP download routes preserve the exact versioned asset name', () => {
  for (const name of ['Windows-Setup-x64.exe', 'Windows-x64.zip']) {
    const asset = `The-Melody-of-Oblivion-Remake-v1.5.3-${name}`;
    const res = response();
    download({ query: { tag: 'v1.5.3', asset } }, res);
    assert.equal(res.code, 302);
    assert.ok(res.destination.endsWith(`/v1.5.3/${asset}`));
  }
});

test('download endpoint redirects only a matching release asset', () => {
  const asset = 'The-Melody-of-Oblivion-Remake-v1.5.2-Windows-x64.exe';
  const valid = response();
  download({ query: { tag: 'v1.5.2', asset } }, valid);
  assert.equal(valid.code, 302);
  assert.equal(valid.destination, `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/v1.5.2/${asset}`);
  assert.equal(valid.headers['Cache-Control'], 'public, max-age=300');

  for (const query of [
    { tag: 'v1.5.1', asset },
    { tag: 'v1.5.2', asset: 'https://example.com/file.exe' },
    { tag: 'v1.5.2', asset: '../file.exe' },
    { tag: 'v1.5.2', asset: `${asset}.sha256` }
  ]) {
    const invalid = response();
    download({ query }, invalid);
    assert.equal(invalid.code, 400);
    assert.equal(invalid.destination, null);
  }
});

test('release endpoint returns public metadata and reports upstream failure', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const release = { tag_name: 'v1.5.2', assets: [] };
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest');
    return { ok: true, json: async () => release };
  };
  const success = response();
  await latestRelease({}, success);
  assert.equal(success.code, 200);
  assert.deepEqual(success.body, release);

  globalThis.fetch = async () => ({ ok: false });
  const failure = response();
  await latestRelease({}, failure);
  assert.equal(failure.code, 502);
});
