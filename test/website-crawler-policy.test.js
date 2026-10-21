const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('website asks compliant crawlers not to index or archive public pages', () => {
  const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent:\s*\*\s*$/m);
  assert.match(robots, /^Disallow:\s*\/\s*$/m);

  const homepage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(homepage, /<meta\s+name="robots"\s+content="noindex, nofollow, noarchive"\s*\/?/i);

  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.ok(vercel.headers.some(rule => rule.source === '/(.*)'
    && rule.headers.some(header => header.key === 'X-Robots-Tag'
      && header.value === 'noindex, nofollow, noarchive')));
});
