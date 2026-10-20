const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { TransactionStore, transactionPaths } = require('../src/main/updater/transaction-store');

async function fixture(t, platform = 'win32') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-journal-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'launcher.exe');
  const store = new TransactionStore({ directory: path.join(directory, 'user-data', 'updates'), target, platform });
  const id = crypto.randomUUID();
  const managed = transactionPaths(target, id, platform);
  const record = { id, platform, arch: 'x64', targetPath: target, ...managed,
    sourcePath: path.join(managed.stagingRoot, 'verified.exe'), phase: 'prepared',
    sha256: 'a'.repeat(64), fromVersion: '1.0.0', toVersion: '2.0.0', error: '' };
  await store.save(record);
  return { store, record };
}

test('Windows journal reads recover from transient busy and permission locks', async (t) => {
  const { store, record } = await fixture(t);
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    let attempts = 0;
    store.fs = { ...fs, readFile: async (...args) => {
      if (++attempts <= 2) throw Object.assign(new Error('temporary sharing violation'), { code });
      return fs.readFile(...args);
    } };
    store.records = [];
    assert.deepEqual(await store.load(), [record]);
    assert.equal(attempts, 3);
  }
});

test('Windows journal writes and atomic commits retry locks without changing the staged report', async (t) => {
  const { store, record } = await fixture(t);
  let writes = 0;
  let commits = 0;
  const temporaries = new Set();
  store.fs = { ...fs,
    writeFile: async (filename, ...args) => {
      temporaries.add(filename);
      if (++writes <= 2) throw Object.assign(new Error('temporary write lock'), { code: 'EACCES' });
      return fs.writeFile(filename, ...args);
    },
    rename: async (...args) => {
      if (++commits <= 2) throw Object.assign(new Error('temporary destination lock'), { code: 'EPERM' });
      return fs.rename(...args);
    }
  };
  await store.save({ ...record, phase: 'awaiting-health' });
  assert.equal(writes, 3);
  assert.equal(commits, 3);
  assert.equal(temporaries.size, 1);
  const report = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.equal(report.records[0].phase, 'awaiting-health');
  assert.deepEqual(await fs.readdir(path.dirname(store.filePath)), [path.basename(store.filePath)]);
});

test('persistent Windows journal locks stop retrying and preserve the original error and bytes', async (t) => {
  const { store, record } = await fixture(t);
  const before = await fs.readFile(store.filePath, 'utf8');
  const busy = Object.assign(new Error('persistent sharing violation'), { code: 'EBUSY' });
  let reads = 0;
  store.fs = { ...fs, readFile: async () => { reads++; throw busy; } };
  await assert.rejects(store.load(), (error) => error === busy);
  assert.equal(reads, 7);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), before);

  const denied = Object.assign(new Error('persistent permission denial'), { code: 'EACCES' });
  let commits = 0;
  store.fs = { ...fs, rename: async () => { commits++; throw denied; } };
  await assert.rejects(store.save({ ...record, phase: 'confirmed' }), (error) => error === denied);
  assert.equal(commits, 7);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), before);
  assert.deepEqual(await fs.readdir(path.dirname(store.filePath)), [path.basename(store.filePath)]);
});

test('invalid JSON and non-Windows permission errors remain immediate errors', async (t) => {
  const { store } = await fixture(t);
  await fs.writeFile(store.filePath, '{broken JSON');
  let reads = 0;
  store.fs = { ...fs, readFile: async (...args) => { reads++; return fs.readFile(...args); } };
  await assert.rejects(store.load(), SyntaxError);
  assert.equal(reads, 1);
  assert.equal(await fs.readFile(store.filePath, 'utf8'), '{broken JSON');

  store.platform = 'linux';
  reads = 0;
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  store.fs = { ...fs, readFile: async () => { reads++; throw denied; } };
  await assert.rejects(store.load(), (error) => error === denied);
  assert.equal(reads, 1);
});
