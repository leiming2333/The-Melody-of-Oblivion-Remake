const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { MinecraftSourceManager } = require('../src/main/minecraft/source-manager');
const { MinecraftDownloader, fileMatches, writeInstallationMarker } = require('../src/main/minecraft/downloader');
const { hasInstallationMarker, readInstallationMarkerState } = require('../src/main/minecraft/installation-files');
const { validateAssetIndex, validateVersionMetadata } = require('../src/main/minecraft/metadata-schema');
const { MinecraftVersionManager, validateProfileId } = require('../src/main/minecraft/version-manager');
const { readVersionMetadata } = require('../src/main/minecraft/version-metadata');
const { ruleMatches, rulesAllow } = require('../src/main/minecraft/platform-rules');
const { platformName } = require('../src/main/minecraft/platform-rules');

const sha1 = (bytes) => crypto.createHash('sha1').update(bytes).digest('hex');
async function temporaryDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-metadata-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function write(root, relative, bytes) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return file;
}

test('JSON sources verify raw bytes and retry the other source after an integrity failure', async (t) => {
  const good = Buffer.from('{ "objects": {} }\n');
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response(requests.length === 1 ? '{"objects":{}}' : good);
  });
  const manager = new MinecraftSourceManager();
  const result = await manager.fetchJsonFromSources('asset-index',
    { originalUrl: 'https://example.test/index.json' }, 'official',
    { sha1: sha1(good), size: good.length, validate: validateAssetIndex });
  assert.equal(requests.length, 2);
  assert.equal(result.source.id, 'bmclapi');
  assert.deepEqual(result.bytes, good);
  assert.deepEqual(result.data, { objects: {} });
});

test('all JSON sources with invalid declared hashes or sizes fail before parsed data is accepted', async (t) => {
  const content = Buffer.from('{"objects":{}}');
  t.mock.method(globalThis, 'fetch', async () => new Response(content));
  const manager = new MinecraftSourceManager();
  for (const integrity of [{ sha1: '0'.repeat(40) }, { size: content.length + 1 }]) {
    await assert.rejects(manager.fetchJsonFromSources('asset-index',
      { originalUrl: 'https://example.test/index.json' }, 'official', integrity), /校验失败/);
  }
});

test('asset indexes reject missing, array and malformed object tables', () => {
  for (const document of [null, [], {}, { objects: [] }, { objects: { sound: null } },
    { objects: { sound: { hash: '0'.repeat(40), size: -1 } } }]) {
    assert.throws(() => validateAssetIndex(document), /资源索引格式无效/);
  }
});

test('logging configuration IDs are single safe filenames and cannot redirect managed writes into user data', () => {
  const metadata = (id) => ({ id: 'fixture', logging: { client: { file: { id, url: 'https://fixture.test/log' } } } });
  assert.equal(validateVersionMetadata(metadata('client-1.12.xml'), 'fixture').logging.client.file.id, 'client-1.12.xml');
  for (const id of ['../../mods/user.jar', '..\\..\\mods\\user.jar', 'nested/client.xml', 'nested\\client.xml', 'C:\\mods\\user.jar']) {
    assert.throws(() => validateVersionMetadata(metadata(id), 'fixture'), /格式无效/, id);
  }
});

test('installation preserves upstream JSON bytes and never substitutes serialization for a declared digest', async (t) => {
  const root = await temporaryDirectory(t);
  const index = Buffer.from('{ "objects": {} }\n');
  const version = Buffer.from(JSON.stringify({ id: 'fixture', mainClass: 'Main', libraries: [],
    assetIndex: { id: 'fixture', url: 'https://example.test/index', sha1: sha1(index), size: index.length } }, null, 1));
  const source = { id: 'official', label: 'Official' };
  const manager = new MinecraftSourceManager();
  manager.getVersionManifest = async () => ({ source,
    manifest: { versions: [{ id: 'fixture', url: 'https://example.test/version', sha1: sha1(version) }] } });
  t.mock.method(globalThis, 'fetch', async (url) => new Response(String(url).endsWith('/version') ? version : index));
  const downloader = new MinecraftDownloader({ gameDirectory: root, sourceManager: manager });
  await downloader.installVersion('fixture');
  assert.deepEqual(await fs.readFile(path.join(root, 'versions/fixture/fixture.json')), version);
  assert.deepEqual(await fs.readFile(path.join(root, 'assets/indexes/fixture.json')), index);
  manager.fetchJsonFromSources = async () => ({ source, data: JSON.parse(version) });
  await assert.rejects(downloader.installVersion('fixture'), /缺少原始下载内容/);
});

test('inherited profiles verify the parent client, merged libraries and original index digest', async (t) => {
  const root = await temporaryDirectory(t);
  const client = Buffer.from('base client');
  const library = Buffer.from('loader library');
  const asset = Buffer.from('sound');
  const assetHash = sha1(asset);
  const index = Buffer.from(JSON.stringify({ objects: { 'sound.ogg': { hash: assetHash, size: asset.length } } }));
  await write(root, 'versions/base/base.json', JSON.stringify({ id: 'base', mainClass: 'Main',
    downloads: { client: { sha1: sha1(client), size: client.length } },
    assetIndex: { id: 'fixture', sha1: sha1(index), size: index.length } }));
  await write(root, 'versions/中文 整合包/中文 整合包.json', JSON.stringify({ id: '中文 整合包', inheritsFrom: 'base',
    libraries: [{ name: 'example:loader:1', downloads: { artifact: {
      path: 'example/loader/1/loader-1.jar', url: 'https://example.test/library', sha1: sha1(library), size: library.length
    } } }] }));
  await write(root, 'versions/base/base.jar', client);
  await write(root, 'libraries/example/loader/1/loader-1.jar', library);
  await write(root, 'assets/indexes/fixture.json', index);
  await write(root, `assets/objects/${assetHash.slice(0, 2)}/${assetHash}`, asset);
  const downloader = new MinecraftDownloader({ gameDirectory: root, sourceManager: new MinecraftSourceManager() });
  assert.equal((await downloader.verifyVersion('中文 整合包')).complete, true);
  assert.equal(await hasInstallationMarker(root, '中文 整合包'), true);
  assert.deepEqual(await readInstallationMarkerState(root, '中文 整合包'), { complete: true, coversInheritance: true });
  const profiles = (await new MinecraftVersionManager({ gameDirectory: root }).listLocalProfiles()).profiles;
  assert.equal(profiles.find((profile) => profile.profileId === '中文 整合包').complete, true);
  assert.equal(profiles.find((profile) => profile.profileId === 'base').complete, false);
  await write(root, 'assets/indexes/fixture.json', '{"objects":{}}');
  const damaged = await downloader.verifyVersion('中文 整合包');
  assert.equal(damaged.complete, false);
  assert.equal(damaged.missingCount, 1);
  assert.ok(damaged.missingFiles.some((name) => name.includes('资源索引')));
  assert.equal(await hasInstallationMarker(root, '中文 整合包'), false);
  await fs.rm(path.join(root, 'versions/base/base.json'));
  const missingParent = await downloader.verifyVersion('中文 整合包');
  assert.equal(missingParent.complete, false);
  assert.match(missingParent.missingFiles[0], /base/);
});

test('one malformed local version cannot hide valid localized profiles', async (t) => {
  const root = await temporaryDirectory(t);
  await write(root, 'versions/中文 版本/中文 版本.json', JSON.stringify({ id: '中文 版本', mainClass: 'Main' }));
  await write(root, 'versions/broken/broken.json', JSON.stringify({ id: 'broken', libraries: {} }));
  const result = await new MinecraftVersionManager({ gameDirectory: root }).listLocalProfiles();
  assert.equal(result.profiles.find((profile) => profile.profileId === '中文 版本').valid, true);
  assert.equal(result.profiles.find((profile) => profile.profileId === 'broken').valid, false);
  await assert.rejects(readVersionMetadata(root, 'broken'), /libraries/);
});

test('an explicit custom client JAR does not inherit the parent client checksum', async (t) => {
  const root = await temporaryDirectory(t);
  const original = Buffer.from('original client');
  await write(root, 'versions/base/base.json', JSON.stringify({ id: 'base', mainClass: 'Main',
    downloads: { client: { sha1: sha1(original), size: original.length } } }));
  await write(root, 'versions/custom/custom.json', JSON.stringify({ id: 'custom', inheritsFrom: 'base', jar: 'patched' }));
  await write(root, 'versions/patched/patched.jar', 'custom patched client');
  const metadata = await readVersionMetadata(root, 'custom');
  assert.equal(metadata.clientJarId, 'patched');
  assert.equal(metadata.clientDownload, undefined);
  const downloader = new MinecraftDownloader({ gameDirectory: root, sourceManager: new MinecraftSourceManager() });
  assert.equal((await downloader.verifyVersion('custom')).complete, true);
});

test('partial loader markers require a parent marker until an entire inherited launch has been verified', async (t) => {
  const root = await temporaryDirectory(t);
  await write(root, 'versions/base/base.json', JSON.stringify({ id: 'base', mainClass: 'Main' }));
  await write(root, 'versions/base/base.jar', 'client');
  const childJson = await write(root, 'versions/loader/loader.json', JSON.stringify({ id: 'loader', inheritsFrom: 'base' }));
  await writeInstallationMarker(root, 'loader', [{ destination: childJson }]);
  const manager = new MinecraftVersionManager({ gameDirectory: root });
  assert.deepEqual(await readInstallationMarkerState(root, 'loader'), { complete: true, coversInheritance: false });
  assert.equal((await manager.listLocalProfiles()).profiles.find((profile) => profile.profileId === 'loader').complete, false);
  const downloader = new MinecraftDownloader({ gameDirectory: root, sourceManager: new MinecraftSourceManager() });
  assert.equal((await downloader.verifyVersion('loader')).complete, true);
  assert.equal((await manager.listLocalProfiles()).profiles.find((profile) => profile.profileId === 'loader').complete, true);
  assert.equal(await hasInstallationMarker(root, 'base'), false);
  await fs.rm(path.join(root, 'versions/base/base.jar'));
  assert.equal((await manager.listLocalProfiles()).profiles.find((profile) => profile.profileId === 'loader').complete, false);
});

test('localized profile IDs retain traversal and Windows reserved-name protection', () => {
  assert.equal(validateProfileId('1.21.1 中文 整合包'), '1.21.1 中文 整合包');
  for (const id of ['', '.', '..', '../foo', 'a/b', 'a\\b', 'CON', 'aux.txt', 'LPT1', 'com².txt', 'a:', 'a.', 'a ']) {
    assert.throws(() => validateProfileId(id), /格式无效/, id);
  }
});

test('installation markers check lightweight file presence and size instead of only JSON structure', async (t) => {
  const root = await temporaryDirectory(t);
  const file = await write(root, 'versions/fixture/fixture.json', '{"id":"fixture"}');
  await writeInstallationMarker(root, 'fixture', [{ destination: file, size: (await fs.stat(file)).size }]);
  assert.equal(await hasInstallationMarker(root, 'fixture'), true);
  await fs.writeFile(file, '{}');
  assert.equal(await hasInstallationMarker(root, 'fixture'), false);
  await writeInstallationMarker(root, 'fixture', []);
  assert.equal(await hasInstallationMarker(root, 'fixture'), false);
});

test('platform rules share architecture aliases, OS versions and feature matching', () => {
  assert.equal(ruleMatches({ action: 'allow', os: { arch: 'x(86|64)' } }, {}, { arch: 'x64' }), true);
  assert.equal(ruleMatches({ action: 'allow', os: { arch: 'x86' } }, {}, { arch: 'ia32' }), true);
  assert.equal(ruleMatches({ action: 'allow', os: { arch: 'x86' } }, {}, { arch: 'x64' }), false);
  assert.equal(ruleMatches({ action: 'allow', os: { arch: 'aarch64' } }, {}, { arch: 'arm64' }), true);
  assert.equal(ruleMatches({ action: 'allow', os: { version: '^10\\.' } }, {}, { release: '6.1' }), false);
  assert.equal(rulesAllow([{ action: 'allow' }, { action: 'disallow', features: { demo: true } }]), true);
  assert.equal(rulesAllow([{ action: 'allow' }, { action: 'disallow', features: { demo: true } }], { demo: true }), false);
});

test('file verification honors SHA-256 as well as SHA-1', async (t) => {
  const root = await temporaryDirectory(t);
  const content = Buffer.from('installer');
  const file = await write(root, 'installer.jar', content);
  assert.equal(await fileMatches(file, { sha256: crypto.createHash('sha256').update(content).digest('hex') }), true);
  assert.equal(await fileMatches(file, { sha256: '0'.repeat(64) }), false);
});

async function repairFixture(t) {
  const root = await temporaryDirectory(t);
  const client = Buffer.from('original client');
  const library = Buffer.from('library content');
  const native = Buffer.from('native archive');
  const logging = Buffer.from('logging config');
  const asset = Buffer.from('asset contents');
  const assetHash = sha1(asset);
  const index = Buffer.from(`{ "objects": {"sound.ogg": {"hash":"${assetHash}","size":${asset.length}}} }\n`);
  const descriptor = (bytes, url, extra = {}) => ({ sha1: sha1(bytes), size: bytes.length, url, ...extra });
  const base = { id: 'base', mainClass: 'Main',
    downloads: { client: descriptor(client, 'https://fixture.test/client') },
    assetIndex: descriptor(index, 'https://fixture.test/index', { id: 'fixture' }),
    logging: { client: { argument: '-Dlog=${path}', file: descriptor(logging, 'https://fixture.test/log', { id: 'logging.xml' }) } },
    libraries: [{ name: 'example:library:1',
      natives: { [platformName()]: 'native-test' },
      downloads: { artifact: descriptor(library, 'https://fixture.test/library', { path: 'example/library/1/library-1.jar' }),
        classifiers: { 'native-test': descriptor(native, 'https://fixture.test/native', { path: 'example/library/1/library-1-native-test.jar' }) } } }]
  };
  const baseJson = JSON.stringify(base);
  const childJson = JSON.stringify({ id: '中文 整合包', inheritsFrom: 'base' });
  await write(root, 'versions/base/base.json', baseJson);
  await write(root, 'versions/中文 整合包/中文 整合包.json', childJson);
  await write(root, 'versions/base/base.jar', client);
  await write(root, 'libraries/example/library/1/library-1.jar', 'x'.repeat(library.length));
  await write(root, 'assets/indexes/fixture.json', '{"objects":{}}');
  const preserved = new Map([
    ['mods/user.jar', 'user mod'], ['saves/world/level.dat', 'world data'],
    ['config/mod.toml', 'mod configuration'], ['melody-instances/pack/saves/world/level.dat', 'instance world']
  ]);
  for (const [relative, bytes] of preserved) await write(root, relative, bytes);
  const responses = new Map([
    ['https://fixture.test/client', client], ['https://fixture.test/library', library],
    ['https://fixture.test/native', native], ['https://fixture.test/log', logging],
    ['https://fixture.test/index', index],
    [`https://resources.download.minecraft.net/${assetHash.slice(0, 2)}/${assetHash}`, asset]
  ]);
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    const bytes = responses.get(String(url));
    return new Response(bytes ?? 'unavailable', { status: bytes ? 200 : 404 });
  });
  const sourceManager = new MinecraftSourceManager();
  sourceManager.setDownloadPreference('official');
  const downloader = new MinecraftDownloader({ gameDirectory: root, sourceManager, concurrency: 3 });
  return { root, downloader, sourceManager, requested, responses, preserved, index, base, asset, assetHash, library, native, logging,
    async assertPreserved() {
      assert.equal(await fs.readFile(path.join(root, 'versions/base/base.json'), 'utf8'), baseJson);
      assert.equal(await fs.readFile(path.join(root, 'versions/中文 整合包/中文 整合包.json'), 'utf8'), childJson);
      for (const [relative, bytes] of preserved) assert.equal(await fs.readFile(path.join(root, relative), 'utf8'), bytes);
    }
  };
}

test('repair restores inherited libraries, natives, logging and assets while preserving mods and saves', async (t) => {
  const f = await repairFixture(t);
  const progress = [];
  const result = await f.downloader.repairVersion('中文 整合包', (entry) => progress.push(entry));
  assert.equal(result.complete, true);
  assert.equal(result.repaired, true);
  assert.equal(await hasInstallationMarker(f.root, '中文 整合包'), true);
  assert.equal((await new MinecraftVersionManager({ gameDirectory: f.root }).listLocalProfiles()).profiles
    .find((profile) => profile.profileId === '中文 整合包').complete, true);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'assets/indexes/fixture.json')), f.index);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'libraries/example/library/1/library-1.jar')), f.library);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'libraries/example/library/1/library-1-native-test.jar')), f.native);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'assets/log_configs/logging.xml')), f.logging);
  assert.equal(f.requested.includes('https://fixture.test/client'), false);
  assert.ok(progress.some((entry) => entry.phase === 'verifying'));
  assert.equal(progress.at(-1).phase, 'complete');
  await f.assertPreserved();

  f.requested.length = 0;
  await fs.rm(path.join(f.root, 'assets/objects', f.assetHash.slice(0, 2), f.assetHash));
  await f.downloader.repairVersion('中文 整合包');
  assert.deepEqual(f.requested, [`https://resources.download.minecraft.net/${f.assetHash.slice(0, 2)}/${f.assetHash}`]);
  await f.assertPreserved();
});

test('repair rejects an untrusted replacement index and never marks it complete', async (t) => {
  const f = await repairFixture(t);
  f.responses.set('https://fixture.test/index', Buffer.from('{"objects":{}}'));
  f.responses.set('https://bmclapi2.bangbang93.com/index', Buffer.from('{"objects":{}}'));
  await assert.rejects(f.downloader.repairVersion('中文 整合包'), /校验失败/);
  assert.equal(await hasInstallationMarker(f.root, '中文 整合包'), false);
  assert.equal(f.requested.some((url) => url.includes('/library')), false);
  await f.assertPreserved();
});

test('repair reports malformed local metadata instead of guessing a loader reinstallation', async (t) => {
  const root = await temporaryDirectory(t);
  await write(root, 'versions/broken/broken.jar', 'existing custom client');
  await write(root, 'mods/user.jar', 'user mod');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('Unexpected network request'); });
  const downloader = new MinecraftDownloader({ gameDirectory: root, sourceManager: new MinecraftSourceManager() });
  for (const metadata of [{ id: 'broken', libraries: {} },
    { id: 'broken', logging: { client: { file: { id: '../../mods/user.jar', url: 'https://fixture.test/log' } } } }]) {
    await write(root, 'versions/broken/broken.json', JSON.stringify(metadata));
    await assert.rejects(downloader.repairVersion('broken'), (error) => {
      assert.equal(error.code, 'GAME_METADATA_INVALID');
      assert.match(error.message, /重新安装/);
      return true;
    });
    assert.equal((await downloader.verifyVersion('broken')).complete, false);
  }
  assert.equal(requests, 0);
  assert.equal(await fs.readFile(path.join(root, 'mods/user.jar'), 'utf8'), 'user mod');
});

test('repair clearly rejects a missing index without a trusted source URL and respects cancellation', async (t) => {
  const root = await temporaryDirectory(t);
  await write(root, 'versions/fixture/fixture.json', JSON.stringify({ id: 'fixture', mainClass: 'Main', assetIndex: { id: 'fixture' } }));
  await write(root, 'versions/fixture/fixture.jar', 'existing custom client');
  const downloader = new MinecraftDownloader({ gameDirectory: root, sourceManager: new MinecraftSourceManager() });
  await assert.rejects(downloader.repairVersion('fixture'), { code: 'GAME_REPAIR_UNAVAILABLE' });
  await assert.rejects(downloader.repairVersion('fixture', () => {}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
