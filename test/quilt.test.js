const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { MinecraftLoaderManager, loaderProfileCandidates } = require('../src/main/minecraft/loader-manager');
const { MinecraftSourceManager } = require('../src/main/minecraft/source-manager');
const { parseModrinthIndex } = require('../src/main/minecraft/modpack-manager');
const { prepareLaunch } = require('../src/main/minecraft/launch-core');

test('Quilt metadata installs an inherited profile and prepares an isolated launch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-quilt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const urls = [];
  const id = 'quilt-loader-0.26.4-1.20.1';
  const profile = { id, inheritsFrom: '1.20.1', mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient', libraries: [] };
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    return new Response(JSON.stringify(String(url).endsWith('/profile/json') ? profile : [{ loader: { version: '0.26.4', stable: true } }]));
  });
  const manager = new MinecraftLoaderManager({ gameDirectory: root, sourceManager: new MinecraftSourceManager(),
    downloader: { installVersion: async () => {
      const directory = path.join(root, 'versions', '1.20.1');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, '1.20.1.json'), JSON.stringify({ id: '1.20.1', javaVersion: { majorVersion: 17 },
        arguments: { game: ['--gameDir', '${game_directory}'] } }));
      await fs.writeFile(path.join(directory, '1.20.1.jar'), 'fixture');
      await require('../src/main/minecraft/downloader').writeInstallationMarker(root, '1.20.1', [
        { destination: path.join(directory, '1.20.1.json') }, { destination: path.join(directory, '1.20.1.jar') }
      ]);
      return { source: 'official' };
    } } });
  const result = await manager.installLoader({ gameVersion: '1.20.1', loaderType: 'quilt', loaderVersion: '0.26.4' });
  assert.equal(result.profileId, id);
  assert.ok(urls.every(url => url.startsWith('https://meta.quiltmc.org/v3/')));
  assert.equal((await manager.listLoaderVersions('1.20.1', 'quilt')).versions[0].installed, true);
  const instanceDirectory = path.join(root, 'isolated');
  const launch = await prepareLaunch({ gameDirectory: root, profileId: id, instanceDirectory,
    account: { type: 'offline', name: 'Player', uuid: '01234567-89ab-cdef-0123-456789abcdef' },
    findJava: async (_path, major) => { assert.equal(major, 17); return 'java17'; } });
  assert.equal(launch.mainClass, profile.mainClass);
  assert.equal(launch.gameDirectory, instanceDirectory);
  assert.ok(launch.argumentsList.includes(instanceDirectory));
  await assert.rejects(manager.installLoader({ gameVersion: '1.20.1', loaderType: 'quilt', loaderVersion: 'missing' }), /不支持.*或加载器版本不存在/);
});

test('Quilt modpacks resolve to the Quilt loader instead of vanilla', () => {
  const info = parseModrinthIndex({ formatVersion: 1, game: 'minecraft', versionId: '1', name: 'Quilt Pack',
    dependencies: { minecraft: '1.20.1', 'quilt-loader': '0.26.4' }, files: [] });
  assert.equal(info.loaderType, 'quilt');
  assert.deepEqual(loaderProfileCandidates('quilt', '1.20.1', '0.26.4'), ['quilt-loader-0.26.4-1.20.1']);
});
