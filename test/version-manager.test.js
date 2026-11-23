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
    JSON.stringify({ schemaVersion: 1, profileId,
      files: [{ path: `versions/${profileId}/${profileId}.json` }] }),
    'utf8'
  );
}

async function writeInstance(gameDirectory, instanceId, profileId, name = instanceId) {
  const instanceRoot = path.join(gameDirectory, 'melody-instances', instanceId);
  await fs.mkdir(instanceRoot, { recursive: true });
  await fs.writeFile(path.join(instanceRoot, '.melody-instance.json'), JSON.stringify({
    schemaVersion: 1,
    instanceId,
    profileId,
    name
  }));
  return instanceRoot;
}

test('删除版本只接受安全的启动配置 ID', () => {
  assert.equal(validateProfileId('fabric-loader-0.16.10-1.21.1'), 'fabric-loader-0.16.10-1.21.1');
  assert.throws(() => validateProfileId('../outside'), /格式无效/);
  assert.throws(() => validateProfileId(''), /格式无效/);
  assert.throws(() => validateProfileId('.'), /格式无效/);
  assert.throws(() => validateProfileId('..'), /格式无效/);
});

test('deleting dot IDs never trashes the versions root', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-delete-root-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeProfile(gameDirectory, '1.21.1', { type: 'release' });
  const trashed = [];
  const manager = new MinecraftVersionManager({
    gameDirectory,
    trashItem: async (target) => trashed.push(target)
  });
  for (const profileId of ['.', '..']) {
    await assert.rejects(manager.deleteProfile(profileId), /格式无效/);
  }
  assert.deepEqual(trashed, []);
  await fs.access(path.join(gameDirectory, 'versions', '1.21.1', '1.21.1.json'));
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

const neoForgeInstallerProfile = {
  inheritsFrom: '1.21.1',
  mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
  arguments: { game: ['--fml.neoForgeVersion', '21.1.267', '--launchTarget', 'forgeclient'] },
  libraries: [
    { name: 'net.neoforged.fancymodloader:loader:4.0.45' },
    { name: 'net.fabricmc:sponge-mixin:0.16.4+mixin.0.8.7' },
    { name: 'net.minecraftforge:srgutils:0.4.15' }
  ]
};

test('real NeoForge installer profiles stay NeoForge with shared Fabric and Forge dependencies', () => {
  for (const profileId of ['neoforge-21.1.267', 'renamed-profile', 'fabric-loader-renamed']) {
    assert.equal(detectLoaderType(neoForgeInstallerProfile, profileId), 'neoforge', profileId);
  }
  assert.equal(detectLoaderType({ ...neoForgeInstallerProfile, arguments: undefined }, 'renamed-profile'), 'neoforge');
  assert.equal(detectLoaderType({ ...neoForgeInstallerProfile, libraries: [] }, 'renamed-profile'), 'neoforge');
});

test('renamed profiles use loader coordinates and entrypoints instead of their display names', () => {
  for (const [loaderType, metadata] of [
    ['forge', { mainClass: 'cpw.mods.modlauncher.Launcher',
      libraries: [{ name: 'net.minecraftforge:forge:1.21.1-52.1.21:universal' },
        { name: 'net.fabricmc:sponge-mixin:0.16.4+mixin.0.8.7' }] }],
    ['forge', { libraries: [{ name: 'net.minecraftforge:fmlloader:1.20.1-47.4.0' }] }],
    ['forge', { mainClass: 'net.minecraft.launchwrapper.Launch',
      minecraftArguments: '--tweakClass cpw.mods.fml.common.launcher.FMLTweaker' }],
    ['forge', { mainClass: 'net.minecraft.launchwrapper.Launch',
      minecraftArguments: '--tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker' }],
    ['forge', { arguments: { game: ['--fml.forgeVersion', '52.1.21'] } }],
    ['neoforge', { libraries: [{ name: 'net.neoforged:forge:1.20.1-47.1.106' }] }],
    ['neoforge', { libraries: [{ name: 'net.neoforged:fmlloader:20.4.251' }] }],
    ['neoforge', { libraries: [{ name: 'net.neoforged:neoforge:21.1.267:universal' }] }],
    ['fabric', { libraries: [{ name: 'net.fabricmc:fabric-loader:0.20.1' }] }],
    ['fabric', { mainClass: 'net.fabricmc.loader.launch.knot.KnotClient' }],
    ['fabric', { mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient' }],
    ['quilt', { libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.0' },
      { name: 'org.quiltmc:quilt-loader:0.30.2' }] }],
    ['quilt', { mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient' }]
  ]) {
    assert.equal(detectLoaderType({ inheritsFrom: '1.21.1', ...metadata }, 'renamed-profile'), loaderType,
      JSON.stringify(metadata));
  }
});

test('shared mapping, mixin and utility libraries are not loader evidence', () => {
  const libraries = [
    { name: 'net.fabricmc:sponge-mixin:0.16.4+mixin.0.8.7' },
    { name: 'net.fabricmc:intermediary:1.21.1' },
    { name: 'net.minecraftforge:srgutils:0.4.15' },
    { name: 'net.neoforged:JarJarFileSystems:0.4.1' },
    { name: 'org.quiltmc:quilt-config:1.3.3' }
  ];
  assert.equal(detectLoaderType({ libraries }, 'custom-profile'), 'vanilla');
  assert.equal(detectLoaderType({ inheritsFrom: '1.21.1', libraries }, 'custom-profile'), 'custom');
  assert.equal(detectLoaderType({}, 'fabricated-profile'), 'vanilla');
  for (const [profileId, loaderType] of [
    ['fabric-loader-0.20.1-1.21.1', 'fabric'], ['quilt-loader-0.30.2-1.21.1', 'quilt'],
    ['1.21.1-forge-52.1.21', 'forge'], ['neoforge-21.1.267', 'neoforge']
  ]) assert.equal(detectLoaderType({ inheritsFrom: '1.21.1' }, profileId), loaderType);
});

test('the local profile scan exposes real NeoForge metadata correctly after renaming', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-neoforge-list-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeProfile(gameDirectory, '1.21.1', { mainClass: 'net.minecraft.client.main.Main' });
  await writeProfile(gameDirectory, 'renamed-profile', neoForgeInstallerProfile);
  await writeMarker(gameDirectory, '1.21.1');
  await writeMarker(gameDirectory, 'renamed-profile');
  const { profiles } = await new MinecraftVersionManager({ gameDirectory }).listLocalProfiles();
  const profile = profiles.find(item => item.profileId === 'renamed-profile');
  assert.equal(profile.loaderType, 'neoforge');
  assert.equal(profile.valid, true);
  assert.equal(profile.complete, true);
});

test('版本列表会解析继承链上的 Java 需求并安全终止循环', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-java-requirement-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeProfile(gameDirectory, '1.20.1', {
    type: 'release',
    javaVersion: { majorVersion: 17, component: 'java-runtime-gamma' }
  });
  await writeProfile(gameDirectory, 'fabric-loader-1.20.1', {
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient'
  });
  await writeProfile(gameDirectory, 'modern-standalone', {
    type: 'release',
    javaVersion: { majorVersion: 21 }
  });
  await writeProfile(gameDirectory, 'legacy-default', { type: 'release' });
  await writeProfile(gameDirectory, 'loop-a', { inheritsFrom: 'loop-b' });
  await writeProfile(gameDirectory, 'loop-b', { inheritsFrom: 'loop-a' });
  await writeMarker(gameDirectory, '1.20.1');
  await writeMarker(gameDirectory, 'fabric-loader-1.20.1');
  await writeInstance(gameDirectory, 'pack-instance', 'fabric-loader-1.20.1', '测试整合包');

  const manager = new MinecraftVersionManager({ gameDirectory });
  const result = await manager.listLocalProfiles();
  const profiles = new Map(result.profiles.map((profile) => [profile.targetId ?? profile.profileId, profile]));
  assert.equal(profiles.get('1.20.1').requiredJavaVersion, 17);
  assert.equal(profiles.get('fabric-loader-1.20.1').requiredJavaVersion, 17);
  assert.equal(profiles.get('modern-standalone').requiredJavaVersion, 21);
  assert.equal(profiles.get('legacy-default').requiredJavaVersion, 8);
  assert.equal(profiles.get('loop-a').requiredJavaVersion, 8);
  assert.equal(profiles.get('instance-pack-instance').requiredJavaVersion, 17);
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

test('整合包引用的加载器受到删除保护，移除实例后才能删除', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-instance-delete-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeProfile(gameDirectory, 'fabric-test', { type: 'release' });
  const instanceRoot = await writeInstance(gameDirectory, 'adventure-pack', 'fabric-test', 'Adventure Pack');
  const trashed = [];
  const manager = new MinecraftVersionManager({
    gameDirectory,
    trashItem: async (target) => trashed.push(target)
  });

  await assert.rejects(manager.deleteProfile('fabric-test'), /请先删除.*Adventure Pack.*adventure-pack/);
  assert.deepEqual(trashed, []);
  await fs.access(path.join(gameDirectory, 'versions', 'fabric-test', 'fabric-test.json'));
  await fs.access(path.join(instanceRoot, '.melody-instance.json'));

  await fs.rm(instanceRoot, { recursive: true });
  await manager.deleteProfile('fabric-test');
  assert.deepEqual(trashed, [path.join(gameDirectory, 'versions', 'fabric-test')]);
});

test('版本依赖会包含继承链上的整合包并安全终止无关循环', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-instance-chain-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeProfile(gameDirectory, 'base', { type: 'release' });
  await writeProfile(gameDirectory, 'loader', { inheritsFrom: 'base' });
  await writeProfile(gameDirectory, 'custom', { inheritsFrom: 'loader' });
  await writeProfile(gameDirectory, 'cycle-a', { inheritsFrom: 'cycle-b' });
  await writeProfile(gameDirectory, 'cycle-b', { inheritsFrom: 'cycle-a' });
  await writeInstance(gameDirectory, 'pack', 'custom', 'Adventure Pack');
  await writeInstance(gameDirectory, 'unrelated-pack', 'cycle-a');
  const manager = new MinecraftVersionManager({ gameDirectory });

  assert.deepEqual(await manager.findDependents('base'), [
    'custom', 'loader', '整合包 Adventure Pack（pack）'
  ]);
  await assert.rejects(manager.deleteProfile('loader'), /Adventure Pack/);
});

test('即使版本目录缺失也会扫描实例的直接引用', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-instance-missing-version-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeInstance(gameDirectory, 'pack', 'missing-loader');
  const manager = new MinecraftVersionManager({ gameDirectory });
  assert.deepEqual(await manager.findDependents('missing-loader'), ['整合包 pack（pack）']);
});
