const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { JavaProbeCache } = require('../src/main/minecraft/java-probe-cache');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-java-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'jdk', 'bin', 'java.exe');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, 'java');
  let calls = 0;
  let version = 21;
  const options = { probe: async () => { calls += 1; return version; } };
  const filePath = path.join(root, 'user-data', 'java-cache.json');
  return { root, executable, filePath, options,
    cache: new JavaProbeCache(filePath, options),
    calls: () => calls, setVersion: (value) => { version = value; } };
}

test('Java probes persist across launcher runs and coalesce concurrent requests', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await Promise.all([f.cache.probe(f.executable), f.cache.probe(f.executable)]), [21, 21]);
  const reopened = new JavaProbeCache(f.filePath, f.options);
  assert.equal(await reopened.probe(f.executable), 21);
  assert.equal(f.calls(), 1);
});

test('replaced executables, release metadata and JVM libraries invalidate cached Java', async (t) => {
  const f = await fixture(t);
  await f.cache.probe(f.executable);
  f.setVersion(25);
  await fs.writeFile(f.executable, 'replacement Java executable');
  assert.equal(await f.cache.probe(f.executable), 25);
  await fs.writeFile(path.join(f.root, 'jdk', 'release'), 'JAVA_VERSION=25');
  await f.cache.probe(f.executable);
  await fs.mkdir(path.join(f.root, 'jdk', 'bin', 'server'));
  await fs.writeFile(path.join(f.root, 'jdk', 'bin', 'server', 'jvm.dll'), 'new runtime');
  await f.cache.probe(f.executable);
  assert.equal(f.calls(), 4);
  await fs.unlink(f.executable);
  assert.equal(await f.cache.probe(f.executable), undefined);
});

test('manual redetection bypasses cache and PATH commands are never persisted', async (t) => {
  const f = await fixture(t);
  await f.cache.probe(f.executable);
  f.setVersion(17);
  assert.equal(await f.cache.probe(f.executable, { force: true }), 17);
  await f.cache.probe('java');
  await f.cache.probe('java');
  assert.equal(f.calls(), 4);
});

test('corrupt or unwritable cache does not prevent Java detection', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.filePath), { recursive: true });
  await fs.writeFile(f.filePath, '{invalid');
  assert.equal(await f.cache.probe(f.executable), 21);
  const blocked = new JavaProbeCache(f.filePath, { ...f.options,
    fileSystem: { ...fs, writeFile: async () => { throw new Error('EACCES'); } } });
  assert.equal(await blocked.probe(f.executable, { force: true }), 21);
});

test('failed Java probes are not reused as valid cached results', async (t) => {
  const f = await fixture(t);
  await f.cache.probe(f.executable);
  f.setVersion(undefined);
  assert.equal(await f.cache.probe(f.executable, { force: true }), undefined);
  const reopened = new JavaProbeCache(f.filePath, f.options);
  assert.equal(await reopened.probe(f.executable), undefined);
  assert.equal(f.calls(), 3);
});
