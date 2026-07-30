const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  MinecraftVersionManager,
  detectLoaderType,
  validateProfileId
} = require('../src/main/minecraft/version-manager');

async function writeProfile(gameDirectory, profileId, metadata) {
  const profileRoot = path.join(gameDirectory, 'versions', profileId);
  await fs.mkdir(profileRoot, { recursive: true });
  await fs.writeFile(
    path.join(profileRoot, `${profileId}.json`),
    JSON.stringify({ id: profileId, ...metadata }),
    'utf8'
  );
}

async function writeMarker(gameDirectory, profileId) {
  await fs.writeFile(
    path.join(gameDirectory, 'versions', profileId, '.melody-installed.json'),
    JSON.stringify({ schemaVersion: 1, profileId, files: [] }),
    'utf8'
  );
}

test('删除版本只接受安全的启动配置 ID', () => {
  assert.equal(validateProfileId('fabric-loader-0.16.10-1.21.1'), 'fabric-loader-0.16.10-1.21.1');
  assert.throws(() => validateProfileId('../outside'), /格式无效/);
  assert.throws(() => validateProfileId(''), /格式无效/);
});

test('本地版本会先扫描原版与加载器配置，并检查继承完整性', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-local-list-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeProfile(gameDirectory, '1.21.1', {
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main'
  });
  await writeProfile(gameDirectory, 'fabric-loader-0.16.10-1.21.1', {
    inheritsFrom: '1.21.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient'
  });
  await writeProfile(gameDirectory, 'forge-without-parent', {
    inheritsFrom: 'missing-base',
    mainClass: 'cpw.mods.modlauncher.Launcher',
    libraries: [{ name: 'net.minecraftforge:forge:1.0' }]
  });
  await writeMarker(gameDirectory, '1.21.1');
  await writeMarker(gameDirectory, 'fabric-loader-0.16.10-1.21.1');
  await writeMarker(gameDirectory, 'forge-without-parent');
  const damagedRoot = path.join(gameDirectory, 'versions', 'damaged-profile');
  await fs.mkdir(damagedRoot, { recursive: true });
  await fs.writeFile(path.join(damagedRoot, 'damaged-profile.json'), '{bad json', 'utf8');

  const manager = new MinecraftVersionManager({ gameDirectory });
  const result = await manager.listLocalProfiles();
  const profiles = new Map(result.profiles.map((profile) => [profile.profileId, profile]));
  assert.equal(profiles.get('1.21.1').loaderType, 'vanilla');
  assert.equal(profiles.get('1.21.1').complete, true);
  assert.equal(profiles.get('fabric-loader-0.16.10-1.21.1').loaderType, 'fabric');
  assert.equal(profiles.get('fabric-loader-0.16.10-1.21.1').complete, true);
  assert.equal(profiles.get('forge-without-parent').loaderType, 'forge');
  assert.equal(profiles.get('forge-without-parent').complete, false);
  assert.equal(profiles.get('damaged-profile').valid, false);
});

test('加载器识别会优先区分 NeoForge 与 Forge', () => {
  assert.equal(detectLoaderType({ mainClass: 'net.neoforged.bootstrap.Main' }, 'custom'), 'neoforge');
  assert.equal(detectLoaderType({ libraries: [{ name: 'net.minecraftforge:forge:47.0' }] }, 'custom'), 'forge');
});

test('完整的整合包实例会作为独立的已安装游戏返回', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-instance-list-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeProfile(gameDirectory, 'fabric-test', {
    type: 'release',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient'
  });
  await writeMarker(gameDirectory, 'fabric-test');

  const instanceId = 'adventure-pack-test';
  const instanceRoot = path.join(gameDirectory, 'melody-instances', instanceId);
  await fs.mkdir(instanceRoot, { recursive: true });
  await fs.writeFile(
    path.join(instanceRoot, '.melody-instance.json'),
    JSON.stringify({
      schemaVersion: 1,
      instanceId,
      name: 'Adventure Pack',
      profileId: 'fabric-test',
      loaderType: 'fabric',
      installedAt: '2026-07-27T00:00:00.000Z'
    }),
    'utf8'
  );

  const manager = new MinecraftVersionManager({ gameDirectory });
  const result = await manager.listLocalProfiles();
  const instance = result.profiles.find((profile) => profile.targetId === `instance-${instanceId}`);
  assert.ok(instance);
  assert.equal(instance.profileId, 'fabric-test');
  assert.equal(instance.displayName, 'Adventure Pack');
  assert.equal(instance.complete, true);
  assert.equal(instance.valid, true);
  assert.equal(instance.isInstance, true);
});

test('被加载器继承的原版不能先删除，独立配置会移到回收站', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-version-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeProfile(gameDirectory, '1.21.1', { type: 'release' });
  await writeProfile(gameDirectory, 'fabric-loader-0.16.10-1.21.1', {
    inheritsFrom: '1.21.1'
  });

  const trashed = [];
  const manager = new MinecraftVersionManager({
    gameDirectory,
    trashItem: async (targetPath) => trashed.push(targetPath)
  });
  await assert.rejects(manager.deleteProfile('1.21.1'), /请先删除.*fabric-loader/);
  assert.equal(trashed.length, 0);

  const result = await manager.deleteProfile('fabric-loader-0.16.10-1.21.1');
  assert.equal(result.recoverable, true);
  assert.equal(result.profileId, 'fabric-loader-0.16.10-1.21.1');
  assert.deepEqual(trashed, [
    path.join(gameDirectory, 'versions', 'fabric-loader-0.16.10-1.21.1')
  ]);
});
