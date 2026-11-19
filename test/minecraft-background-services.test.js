const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ModuleProcess } = require('../src/main/module-process');
const { createBackgroundMinecraftServices, createJavaBackgroundService } = require('../src/main/minecraft/background-services');
const { zip } = require('./helpers/zip-fixture');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-background-minecraft-'));
  const directory = path.join(root, '.minecraft');
  const profile = path.join(directory, 'versions', 'fixture');
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'fixture.json'), JSON.stringify({ id: 'fixture', mainClass: 'Main', libraries: [], javaVersion: { majorVersion: 21 } }));
  await fs.writeFile(path.join(profile, 'fixture.jar'), 'fixture-client');
  const app = new EventEmitter();
  Object.assign(app, { getAppPath: () => root, getPath: () => root });
  const config = { downloadSource: 'official', downloadConcurrency: 4 };
  const trash = [];
  const services = createBackgroundMinecraftServices({ app, directory, config,
    shell: { trashItem: async target => { trash.push(target); await fs.rename(target, path.join(root, 'trashed')); } },
    createLauncher: () => { throw new Error('Game launch was not requested'); } });
  t.after(async () => { await services.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, profile, services, trash, config };
}

test('real Minecraft modules use independent processes for files, Mods, downloads, Java, loaders, Fabric API and packs', async t => {
  const observed = new Map();
  const original = ModuleProcess.prototype.invoke;
  t.mock.method(ModuleProcess.prototype, 'invoke', function (...args) {
    observed.set(this.moduleName, this);
    return original.apply(this, args);
  });
  const f = await fixture(t);
  const pack = path.join(f.root, 'preview.mrpack');
  await fs.writeFile(pack, zip([['modrinth.index.json', JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'Preview',
    versionId: 'fixture', files: [], dependencies: { minecraft: '1.21.1' } })]]));
  const profiles = await f.services.versionManager.listLocalProfiles();
  assert.equal(profiles.profiles[0].profileId, 'fixture');
  assert.deepEqual(await f.services.versionManager.getJavaRequirement('fixture'), { majorVersion: 21 });
  const modsDirectory = await f.services.versionManager.resolveModDirectory('fixture', true);
  const source = path.join(f.root, 'example.jar');
  await fs.writeFile(source, 'fixture-mod');
  await f.services.modManager.importFile(modsDirectory, source);
  assert.equal((await f.services.modManager.list(modsDirectory))[0].name, 'example.jar');
  await f.services.modManager.setEnabled(modsDirectory, 'example.jar', false);
  assert.equal((await f.services.modManager.list(modsDirectory))[0].enabled, false);
  await f.services.downloader.verifyVersion('fixture');
  assert.equal(await f.services.javaRuntime.inspect(path.join(f.root, 'missing-java')), undefined);
  assert.equal((await f.services.modpackManager.inspect(pack)).name, 'Preview');
  assert.equal(await f.services.modpackManager.claimRecoverySession(1), null);
  await assert.rejects(f.services.loaderManager.listLoaderVersions('../invalid', 'forge'), /Minecraft 版本号格式无效/);
  await assert.rejects(f.services.fabricApiManager.listVersions('../invalid'), /版本/);
  const names = ['versions', 'mods', 'download', 'java', 'modpacks', 'loaders', 'fabric-api'];
  const pids = names.map(name => observed.get(`minecraft-${name}`).worker.child.pid);
  assert.equal(new Set(pids).size, names.length);
  assert.ok(pids.every(pid => pid !== process.pid));
  for (const name of ['version-manager', 'mod-manager', 'downloader', 'loader-manager', 'managed-java-runtime', 'modpack-manager', 'fabric-api-manager']) {
    assert.equal(require.cache[require.resolve(`../src/main/minecraft/${name}`)], undefined, `${name} must stay outside the main process`);
  }
});

test('isolated version deletion delegates the Electron trash operation to its owner', async t => {
  const f = await fixture(t);
  await f.services.versionManager.deleteProfile('fixture');
  assert.deepEqual(f.trash, [f.profile]);
  await assert.rejects(fs.access(f.profile), { code: 'ENOENT' });
});

test('a failed module request does not prevent other modules or a later request from running', async t => {
  const f = await fixture(t);
  await assert.rejects(f.services.modpackManager.getRecoveryState('missing', { ownerId: 1 }), { code: 'MODPACK_SESSION_EXPIRED' });
  assert.equal((await f.services.versionManager.listLocalProfiles()).profiles.length, 1);
  assert.equal(await f.services.modpackManager.claimRecoverySession(1), null);
  assert.equal((await f.services.versionManager.getJavaRequirement('fixture')).majorVersion, 21);
});

test('real modpack installation retains its worker state, configuration snapshot and final commit boundary', async t => {
  const f = await fixture(t);
  const { LoaderInstallProcess } = require('../src/main/minecraft/loader-install-process');
  const calls = [];
  t.mock.method(LoaderInstallProcess.prototype, 'installLoader', async function (request, report, { signal }) {
    calls.push({ request, source: this.downloadSource, concurrency: this.concurrency });
    assert.equal(signal?.aborted ?? false, false);
    report({ phase: 'complete', message: 'Base ready' });
    return { profileId: 'fixture' };
  });
  const archive = path.join(f.root, 'install.mrpack');
  await fs.writeFile(archive, zip([
    ['modrinth.index.json', JSON.stringify({ formatVersion: 1, game: 'minecraft', name: 'Installed Pack',
      versionId: 'fixture', files: [], dependencies: { minecraft: 'fixture' } })],
    ['overrides/config/example.txt', 'pack configuration']
  ]));
  const progress = [];
  const result = await f.services.modpackManager.install(archive, value => {
    progress.push(value);
    if (value.phase === 'extracting') f.config.downloadSource = 'bmclapi';
  }, { ownerId: 1 });
  assert.equal(result.status, 'complete');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'official');
  assert.equal(calls[0].concurrency, 4);
  assert.equal(progress.filter(value => value.phase === 'complete').length, 1);
  assert.equal(progress.at(-1).phase, 'complete');
  assert.ok(progress.some(value => value.phase === 'committing-instance' && value.cancellable === false));
  assert.equal(await f.services.modpackManager.claimRecoverySession(1), null);
  assert.equal(await fs.readFile(path.join(f.directory, 'melody-instances', result.instanceId, 'config/example.txt'), 'utf8'), 'pack configuration');
});

test('launch preparation runs in its own process and delegates Java and verification callbacks', async t => {
  const f = await fixture(t);
  const calls = [], progress = [];
  const result = await f.services.launchPreparation.prepareLaunch({ gameDirectory: f.directory, profileId: 'fixture',
    account: { type: 'offline', name: 'Steve', uuid: '0'.repeat(32) }, memoryMb: 1024,
    findJava: async (_explicit, major) => { calls.push(['java', major]); return '/fixture/java'; },
    inspectJava: async executable => { calls.push(['inspect', executable]); return { majorVersion: 21, bits: 64, architecture: process.arch }; },
    verifyFiles: async (id, report) => { calls.push(['verify', id]); report({ checkedFiles: 1, totalFiles: 1 }); return { complete: true }; },
    onVerifyProgress: value => progress.push(value)
  });
  assert.deepEqual(calls, [['verify', 'fixture'], ['java', 21], ['inspect', '/fixture/java']]);
  assert.equal(progress[0].checkedFiles, 1);
  assert.equal(result.javaExecutable, '/fixture/java');
  assert.ok(result.argumentsList.includes('Main'));
  assert.ok(result.argumentsList.includes('-Xmx1024M'));
  assert.equal((await fs.stat(result.nativesDirectory)).isDirectory(), true);
  assert.equal(require.cache[require.resolve('../src/main/minecraft/launch-core')], undefined);
});

test('settings Java probing reuses its own process without loading Java discovery in the caller', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-settings-java-background-'));
  const service = createJavaBackgroundService({ cachePath: path.join(root, 'cache.json'), launcherDirectory: root });
  t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal(await service.javaMajorVersion(path.join(root, 'missing-java')), undefined);
  assert.equal(require.cache[require.resolve('../src/main/minecraft/java-runtime')], undefined);
});

test('Java workers for different game directories save independently and normalized aliases retain the same cache', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-directory-java-cache-'));
  const directories = [path.join(root, 'games', 'one'), path.join(root, 'games', 'two')];
  const app = new EventEmitter();
  Object.assign(app, { getPath: () => root, getAppPath: () => root });
  const services = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.dispose()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const create = directory => {
    const service = createBackgroundMinecraftServices({ app, directory, config: {}, shell: {}, createLauncher() {} });
    services.push(service);
    return service;
  };
  let saving = true, entered = 0, release;
  const bothWriting = new Promise(resolve => { release = resolve; });
  const cachePaths = [];
  t.mock.method(ModuleProcess.prototype, 'invoke', async function (_method, [config]) {
    cachePaths.push(config.javaCachePath);
    if (!saving) return undefined;
    // Model the real cache's write-to-.part/rename transaction in two workers.
    const temporary = `${config.javaCachePath}.part`;
    await fs.writeFile(temporary, this.options.gameDirectory);
    if (++entered === 2) release();
    await bothWriting;
    await fs.rename(temporary, config.javaCachePath);
    return undefined;
  });
  await Promise.all(directories.map(directory => create(directory).javaRuntime.inspect('/unused-java')));
  assert.notEqual(cachePaths[0], cachePaths[1]);
  const saved = await Promise.all(cachePaths.map(filename => fs.readFile(filename, 'utf8')));
  assert.deepEqual(new Set(saved), new Set(directories));
  saving = false;
  const alias = `${path.join(root, 'games', 'unused')}${path.sep}..${path.sep}one${path.sep}`;
  await create(alias).javaRuntime.inspect('/unused-java');
  assert.equal(cachePaths[2], cachePaths[0]);
  if (process.platform === 'win32') {
    await create(directories[0].toUpperCase()).javaRuntime.inspect('/unused-java');
    assert.equal(cachePaths[3], cachePaths[0]);
  }
});
