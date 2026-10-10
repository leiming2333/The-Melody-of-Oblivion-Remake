const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { profileGameDirectory } = require('../src/main/minecraft/launch-target');
const { normalizeSettings } = require('../src/main/settings/settings-store');

test('profiles keep independent mods, saves and options without moving legacy data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-isolation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const a = profileGameDirectory(root, 'Fabric-1.21');
  const b = profileGameDirectory(root, 'fabric-1.21');
  assert.notEqual(a, b);
  await fs.mkdir(path.join(a, 'saves'), { recursive: true });
  await fs.mkdir(path.join(b, 'saves'), { recursive: true });
  await fs.writeFile(path.join(root, 'options.txt'), 'legacy');
  await fs.writeFile(path.join(a, 'options.txt'), 'profile A');
  await fs.writeFile(path.join(b, 'options.txt'), 'profile B');
  assert.equal(await fs.readFile(path.join(root, 'options.txt'), 'utf8'), 'legacy');
  assert.equal(await fs.readFile(path.join(a, 'options.txt'), 'utf8'), 'profile A');
  assert.equal(await fs.readFile(path.join(b, 'options.txt'), 'utf8'), 'profile B');
  assert.throws(() => profileGameDirectory(root, '../escape'));
  assert.equal(normalizeSettings().isolateProfiles, true);
  assert.equal(normalizeSettings({ isolateProfiles: false }).isolateProfiles, false);
});
