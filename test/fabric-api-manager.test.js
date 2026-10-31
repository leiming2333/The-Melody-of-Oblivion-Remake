const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { FabricApiManager, FABRIC_API_PROJECT_ID } = require('../src/main/minecraft/fabric-api-manager');

const contents = Buffer.from('PK\x03\x04 fixture Fabric API JAR');
const versionId = 'Mys3P7lK';
const gameVersion = '1.21.1';
const filename = 'fabric-api-0.116.17+1.21.1.jar';

function metadata(overrides = {}) {
  return {
    id: versionId, project_id: FABRIC_API_PROJECT_ID, name: '[1.21.1] Fabric API 0.116.17+1.21.1',
    version_number: '0.116.17+1.21.1', version_type: 'release', date_published: '2026-09-01T16:40:04.373428Z',
    game_versions: [gameVersion], loaders: ['fabric'], files: [{ filename, primary: true, size: contents.length,
      url: `https://cdn.modrinth.com/data/${FABRIC_API_PROJECT_ID}/versions/${versionId}/${encodeURIComponent(filename)}`,
      hashes: { sha1: crypto.createHash('sha1').update(contents).digest('hex'),
        sha512: crypto.createHash('sha512').update(contents).digest('hex') } }], ...overrides
  };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '旋律 Fabric API '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const instanceDirectory = path.join(root, 'melody-profiles', '中文 空格 实例');
  const raw = metadata();
  const requests = [];
  const downloads = [];
  const manager = new FabricApiManager({ gameDirectory: root, retryDelayMs: 0,
    fetchJson: async (url, { signal }) => {
      requests.push({ url, signal });
      return structuredClone(url.includes('/project/') ? [raw] : raw);
    },
    download: async (task) => {
      downloads.push(task);
      await fs.mkdir(path.dirname(task.destination), { recursive: true });
      await fs.writeFile(task.destination, contents);
      task.onBytes?.(contents.length);
      return { bytes: contents.length };
    }, ...options });
  const install = (onProgress, installOptions, extra = {}) => manager.installVersion({ gameVersion, versionId, instanceDirectory, ...extra }, onProgress, installOptions);
  return { manager, root, instanceDirectory, raw, requests, downloads, install };
}

async function assertClean(f) {
  const cache = path.join(f.root, 'launcher-cache', 'fabric-api');
  let entries = [];
  try { entries = await fs.readdir(cache); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.deepEqual(entries, [], 'no stage directories or partial downloads remain');
}

test('Fabric API project identity and server query are fixed and returned versions are strictly compatible', async () => {
  // P7dR8mSH, slug fabric-api, title Fabric API, project_type mod and loaders
  // [fabric] were confirmed via the real read-only Modrinth API on 2026-10-31.
  assert.equal(FABRIC_API_PROJECT_ID, 'P7dR8mSH');
  const requests = [];
  const manager = new FabricApiManager({ fetchJson: async (url) => {
    requests.push(url);
    return [metadata(), metadata({ id: 'OldApi01', game_versions: ['1.20.1'] }),
      metadata({ id: 'NeoApi01', loaders: ['neoforge'] }), metadata({ id: 'WrongPrj', project_id: 'another-project' })];
  } });
  const result = await manager.listVersions(gameVersion);
  assert.deepEqual(result, { gameVersion, versions: [{ id: versionId, version: '0.116.17+1.21.1',
    name: '[1.21.1] Fabric API 0.116.17+1.21.1', versionType: 'release', datePublished: '2026-09-01T16:40:04.373428Z' }] });
  const query = new URL(requests[0]);
  assert.equal(query.origin + query.pathname, 'https://api.modrinth.com/v2/project/P7dR8mSH/version');
  assert.deepEqual(JSON.parse(query.searchParams.get('game_versions')), [gameVersion]);
  assert.deepEqual(JSON.parse(query.searchParams.get('loaders')), ['fabric']);
  assert.ok(!('file' in result.versions[0]), 'renderer catalog does not carry download authority');
});

test('version lists are cached, detached from callers and refreshed on force', async () => {
  let calls = 0;
  const manager = new FabricApiManager({ fetchJson: async () => { calls += 1; return [metadata()]; } });
  const first = await manager.listVersions(gameVersion);
  first.versions.length = 0;
  assert.equal((await manager.listVersions(gameVersion)).versions.length, 1);
  assert.equal(calls, 1);
  await manager.listVersions(gameVersion, { force: true });
  assert.equal(calls, 2);
});

for (const bad of [{ versions: [] }, [null], [metadata({ game_versions: gameVersion })]]) {
  test(`malformed Fabric API lists are reported (${JSON.stringify(bad).slice(0, 45)})`, async () => {
    const manager = new FabricApiManager({ fetchJson: async () => bad });
    await assert.rejects(manager.listVersions(gameVersion), { code: 'FABRIC_API_METADATA_INVALID' });
  });
}

test('malformed JSON and network HTTP failures have distinct actionable error codes', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"broken":'));
  await assert.rejects(new FabricApiManager().listVersions(gameVersion), { code: 'FABRIC_API_METADATA_INVALID', retryable: false });
  t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 429 }));
  await assert.rejects(new FabricApiManager().listVersions(gameVersion), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.retryable, true);
    assert.equal(error.details.status, 429);
    return true;
  });
});

for (const [description, change, code] of [
  ['different version', { id: 'Other123' }, 'FABRIC_API_VERSION_MISMATCH'],
  ['different project', { project_id: 'Another1' }, 'FABRIC_API_INCOMPATIBLE'],
  ['different game', { game_versions: ['1.20.1'] }, 'FABRIC_API_INCOMPATIBLE'],
  ['different loader', { loaders: ['forge'] }, 'FABRIC_API_INCOMPATIBLE'],
  ['malformed compatibility', { game_versions: gameVersion }, 'FABRIC_API_METADATA_INVALID'],
  ['ambiguous primary file', { files: [] }, 'FABRIC_API_METADATA_INVALID']
]) {
  test(`resolved Fabric API rejects ${description} before downloading`, async (t) => {
    const f = await fixture(t);
    Object.assign(f.raw, change);
    await assert.rejects(f.install(), { code });
    assert.equal(f.downloads.length, 0);
    await assertClean(f);
  });
}

for (const [description, mutate] of [
  ['non-HTTPS URL', (file) => { file.url = file.url.replace('https:', 'http:'); }],
  ['foreign CDN', (file) => { file.url = file.url.replace('cdn.modrinth.com', 'cdn.modrinth.com.evil.test'); }],
  ['foreign version path', (file) => { file.url = file.url.replace(versionId, 'Other123'); }],
  ['traversal filename', (file) => { file.filename = '../fabric-api.jar'; }],
  ['Windows alternate stream', (file) => { file.filename = 'fabric-api.jar:payload.jar'; }],
  ['missing SHA-512', (file) => { delete file.hashes.sha512; }],
  ['missing SHA-1', (file) => { delete file.hashes.sha1; }],
  ['invalid size', (file) => { file.size = -1; }],
  ['no primary file', (file) => { file.primary = false; }]
]) {
  test(`untrusted Fabric API file metadata rejects ${description}`, async (t) => {
    const f = await fixture(t);
    mutate(f.raw.files[0]);
    await assert.rejects(f.install(), { code: 'FABRIC_API_METADATA_INVALID' });
    assert.equal(f.downloads.length, 0);
    await assertClean(f);
  });
}

test('installation trusts only freshly resolved version metadata and supports Chinese and space directories', async (t) => {
  const f = await fixture(t);
  const progress = [];
  const result = await f.install((event) => progress.push(event), undefined,
    { url: 'https://evil.test/renderer.jar', sha1: 'a'.repeat(40), filename: 'injected.jar' });
  assert.equal(result.installed, true);
  assert.equal(result.alreadyInstalled, false);
  assert.equal(result.fileName, filename);
  assert.deepEqual(await fs.readFile(path.join(f.instanceDirectory, 'mods', filename)), contents);
  assert.deepEqual(f.downloads[0].urls, [metadata().files[0].url]);
  assert.equal(f.downloads[0].sha1, metadata().files[0].hashes.sha1);
  assert.equal(progress.find((event) => event.phase === 'committing-fabric-api').cancellable, false);
  assert.ok(progress.some((event) => event.completedBytes === contents.length && event.totalBytes === contents.length));
  assert.equal(progress.at(-1).phase, 'complete');
  await assertClean(f);
  assert.equal((await f.install()).alreadyInstalled, true);
  assert.equal(f.downloads.length, 1, 'verified existing content is idempotent');
  assert.equal(f.requests.length, 2, 'each install revalidates the version independently of the UI');
});

test('the default downloader retries a transient official-CDN failure and validates its JAR', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(String(url), metadata().files[0].url);
    requests += 1;
    return requests === 1 ? new Response('temporary failure', { status: 503 }) : new Response(contents);
  });
  const f = await fixture(t, { download: undefined });
  const events = [];
  await f.install((event) => events.push(event));
  assert.equal(requests, 2);
  assert.ok(events.some((event) => /重试/.test(event.message)));
  assert.deepEqual(await fs.readFile(path.join(f.instanceDirectory, 'mods', filename)), contents);
  await assertClean(f);
});

test('a matching SHA-1 cannot bypass the independent SHA-512 verification', async (t) => {
  const f = await fixture(t);
  f.raw.files[0].hashes.sha512 = '0'.repeat(128);
  await assert.rejects(f.install(), { code: 'CHECKSUM_MISMATCH' });
  assert.equal(f.downloads.length, 3);
  assert.deepEqual(await fs.readdir(path.join(f.instanceDirectory, 'mods')), []);
  await assertClean(f);
});

test('metadata cancellation prevents download, caching and directory creation', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, { fetchJson: async () => { controller.abort(); return metadata(); } });
  await assert.rejects(f.manager.listVersions(gameVersion, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.manager.cache.size, 0);
  assert.equal(f.downloads.length, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('cancelling after a partial download cleans the stage and never commits a Mod', async (t) => {
  const controller = new AbortController();
  const f = await fixture(t, { download: async (task) => {
    assert.equal(task.signal, controller.signal);
    await fs.writeFile(task.destination, 'partial');
    await fs.writeFile(task.destination + '.chunk-0', 'partial chunk');
    controller.abort();
    throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
  } });
  await assert.rejects(f.install(undefined, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(path.join(f.instanceDirectory, 'mods')), []);
  await assertClean(f);
});

for (const name of [filename, 'fabric-api-older.jar', filename + '.disabled']) {
  test(`existing conflicting or disabled Fabric API is preserved (${name})`, async (t) => {
    const f = await fixture(t);
    const directory = path.join(f.instanceDirectory, 'mods');
    await fs.mkdir(directory, { recursive: true });
    const bytes = name.endsWith('.disabled') ? contents : Buffer.from('existing user mod');
    await fs.writeFile(path.join(directory, name), bytes);
    await assert.rejects(f.install(), { code: 'FABRIC_API_CONFLICT', retryable: false });
    assert.deepEqual(await fs.readFile(path.join(directory, name)), bytes);
    assert.equal(f.downloads.length, 0);
    await assertClean(f);
  });
}

test('a renamed identical JAR is idempotent and unrelated notes or mods remain intact', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.instanceDirectory, 'mods');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'user-renamed.jar'), contents);
  await fs.writeFile(path.join(directory, 'fabric-api-notes.txt'), 'personal note');
  await fs.writeFile(path.join(directory, 'another-mod.jar'), 'unrelated mod');
  const result = await f.install();
  assert.equal(result.alreadyInstalled, true);
  assert.equal(result.fileName, 'user-renamed.jar');
  assert.equal(f.downloads.length, 0);
  assert.equal(await fs.readFile(path.join(directory, 'fabric-api-notes.txt'), 'utf8'), 'personal note');
});

test('parallel manager instances serialize installation and preserve idempotence', async (t) => {
  const f = await fixture(t);
  const second = new FabricApiManager({ gameDirectory: f.root, fetchJson: f.manager.fetchJson, download: f.manager.download, retryDelayMs: 0 });
  const results = await Promise.all([f.install(), second.installVersion({ gameVersion, versionId, instanceDirectory: f.instanceDirectory })]);
  assert.deepEqual(results.map((result) => result.alreadyInstalled), [false, true]);
  assert.equal(f.downloads.length, 1);
  await assertClean(f);
});

test('a competing import wins safely without being overwritten by Fabric API installation', async (t) => {
  const f = await fixture(t);
  const original = f.manager.modManager.importFile.bind(f.manager.modManager);
  f.manager.modManager.importFile = async (instance, source) => {
    await fs.writeFile(path.join(instance, 'mods', filename), 'concurrent user import');
    return original(instance, source);
  };
  await assert.rejects(f.install(), { code: 'FABRIC_API_CONFLICT' });
  assert.equal(await fs.readFile(path.join(f.instanceDirectory, 'mods', filename), 'utf8'), 'concurrent user import');
  await assertClean(f);
});

test('disk-full failures are not retried and all owned temporary files are cleaned', async (t) => {
  let attempts = 0;
  const f = await fixture(t, { download: async (task) => {
    attempts += 1;
    await fs.writeFile(task.destination + '.part', 'partial');
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  } });
  await assert.rejects(f.install(), { code: 'ENOSPC' });
  assert.equal(attempts, 1);
  await assertClean(f);
});

for (const successful of [true, false]) {
  test(`stage cleanup errors preserve the ${successful ? 'successful install' : 'original checksum failure'}`, async (t) => {
    const f = await fixture(t);
    if (!successful) f.raw.files[0].hashes.sha512 = '0'.repeat(128);
    const originalRemove = fs.rm;
    t.mock.method(fs, 'rm', async (target, options) => {
      if (path.dirname(target) === path.join(f.root, 'launcher-cache', 'fabric-api') && path.basename(target).startsWith('download-')) {
        throw Object.assign(new Error('antivirus sharing lock'), { code: 'EPERM' });
      }
      return originalRemove(target, options);
    });
    if (successful) {
      const result = await f.install();
      assert.equal(result.installed, true);
      assert.equal(result.alreadyInstalled, false);
      assert.match(result.cleanupWarning, /清理失败.*antivirus sharing lock/);
      assert.deepEqual(await fs.readFile(path.join(f.instanceDirectory, 'mods', filename)), contents);
    } else {
      await assert.rejects(f.install(), (error) => {
        assert.equal(error.code, 'CHECKSUM_MISMATCH');
        assert.match(error.details.cleanupMessage, /清理失败.*antivirus sharing lock/);
        return true;
      });
      assert.deepEqual(await fs.readdir(path.join(f.instanceDirectory, 'mods')), []);
    }
  });
}

test('an instance outside the selected game root is rejected before any download', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.install(undefined, undefined, { instanceDirectory: path.join(f.root, '..', 'outside-instance') }),
    { code: 'FABRIC_API_UNSAFE_PATH' });
  assert.equal(f.downloads.length, 0);
  assert.deepEqual(await fs.readdir(f.root), []);
});

for (const location of ['intermediate', 'mods']) {
  test(`an ${location} junction cannot redirect Fabric API outside the game root`, async (t) => {
    const f = await fixture(t);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fabric-api-link-target-'));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const link = location === 'intermediate' ? path.join(f.root, 'melody-profiles') : path.join(f.instanceDirectory, 'mods');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(f.install(), { code: 'FABRIC_API_UNSAFE_PATH' });
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal(f.downloads.length, 0);
  });
}
