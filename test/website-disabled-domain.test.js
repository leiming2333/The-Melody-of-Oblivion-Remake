const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const disabledDomain = require('../api/disabled-domain');

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

test('disabled-domain endpoint returns a cache-free 410 response', () => {
  const result = response();
  disabledDomain({}, result);
  assert.equal(result.code, 410);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers['X-Robots-Tag'], 'noindex, nofollow, noarchive');
  assert.equal(result.body.error, 'This hostname has been disabled.');
});

test('Vercel routes only the custom hostname to the disabled-domain endpoint', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  const route = vercel.rewrites.find(entry => entry.destination === '/api/disabled-domain');
  assert.ok(route);
  assert.equal(route.source, '/:path*');
  assert.deepEqual(route.has, [{ type: 'host', value: 'the-melody-of-o-r\\.ccwu\\.cc' }]);
});
