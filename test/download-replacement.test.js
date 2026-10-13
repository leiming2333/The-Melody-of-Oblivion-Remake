const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { downloadFile, writeJsonAtomic } = require('../src/main/minecraft/downloader');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-replace-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('failed metadata replacement preserves the previous file and removes only its temporary file', async (t) => {
  const root = await fixture(t);
  const destination = path.join(root, 'version.json');
  await fs.writeFile(destination, '{"id":"previous"}\n');
  t.mock.method(fs, 'rename', async (_temporary, target) => {
    assert.equal(target, destination);
    // The old metadata must exist even while the replacement is attempted.
    assert.equal(await fs.readFile(destination, 'utf8'), '{"id":"previous"}\n');
    throw Object.assign(new Error('replacement denied'), { code: 'EACCES' });
  });
  await assert.rejects(writeJsonAtomic(destination, { id: 'replacement' }), { code: 'EACCES' });
  assert.equal(await fs.readFile(destination, 'utf8'), '{"id":"previous"}\n');
  assert.deepEqual(await fs.readdir(root), ['version.json']);
});

test('simultaneous metadata writers use independent temporary files and publish complete JSON', async (t) => {
  const root = await fixture(t);
  const destination = path.join(root, 'version.json');
  await fs.writeFile(destination, '{"id":"previous"}');
  const originalRename = fs.rename;
  let arrivals = 0;
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const temporaryPaths = [];
  t.mock.method(fs, 'rename', async (temporary, target) => {
    temporaryPaths.push(temporary);
    arrivals += 1;
    if (arrivals === 2) release();
    await ready;
    return originalRename(temporary, target);
  });
  await Promise.all([
    writeJsonAtomic(destination, { id: 'first', libraries: ['one'] }),
    writeJsonAtomic(destination, { id: 'second', libraries: ['two'] })
  ]);
  assert.equal(new Set(temporaryPaths).size, 2);
  const metadata = JSON.parse(await fs.readFile(destination, 'utf8'));
  assert.ok(['first', 'second'].includes(metadata.id));
  assert.deepEqual(metadata.libraries, metadata.id === 'first' ? ['one'] : ['two']);
  assert.deepEqual(await fs.readdir(root), ['version.json']);
});

test('failed verified download replacement keeps the existing file for recovery', async (t) => {
  const root = await fixture(t);
  const destination = path.join(root, 'client.jar');
  const content = Buffer.from('new verified client');
  await fs.writeFile(destination, 'previous client');
  t.mock.method(global, 'fetch', async () => new Response(content));
  t.mock.method(fs, 'rename', async (_temporary, target) => {
    assert.equal(target, destination);
    assert.equal(await fs.readFile(destination, 'utf8'), 'previous client');
    throw Object.assign(new Error('replacement denied'), { code: 'EPERM' });
  });
  await assert.rejects(downloadFile({
    destination, label: 'client', urls: ['https://download.test/client.jar'],
    size: content.length, sha1: crypto.createHash('sha1').update(content).digest('hex')
  }), /replacement denied/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'previous client');
  assert.deepEqual(await fs.readdir(root), ['client.jar']);
});
