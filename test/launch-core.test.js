const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { offlineUuidForSkinModel } = require('../src/main/accounts/account-store');
const {
  expandArgumentEntries,
  extractNativeArchive,
  prepareLaunch,
  readVersionMetadata,
  rulesAllow,
  splitLegacyArguments
} = require('../src/main/minecraft/launch-core');

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [entryName, value] of entries) {
    const name = Buffer.from(entryName);
    const content = Buffer.from(value);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function writeFile(filePath, content = '') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function writeVersion(gameDirectory, id, metadata) {
  await writeFile(
    path.join(gameDirectory, 'versions', id, `${id}.json`),
    JSON.stringify({ id, ...metadata })
  );
}

test('启动参数规则支持功能开关和值数组', () => {
  const entries = [
    'always',
    { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
    {
      rules: [{ action: 'allow', features: { has_custom_resolution: false } }],
      value: ['--width', '${resolution_width}']
    }
  ];
  assert.deepEqual(expandArgumentEntries(entries), ['always', '--width', '${resolution_width}']);
  assert.equal(rulesAllow([{ action: 'disallow' }]), false);
});

test('旧版参数可以保留引号内空格', () => {
  assert.deepEqual(
    splitLegacyArguments('--username Steve --title "My World" --token \'hello world\''),
    ['--username', 'Steve', '--title', 'My World', '--token', 'hello world']
  );
});

test('原生库解压会应用排除项并阻止目录穿越', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-native-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const archivePath = path.join(temporaryRoot, 'natives.jar');
  const destination = path.join(temporaryRoot, 'output');
  await fs.writeFile(archivePath, storedZip([
    ['META-INF/MANIFEST.MF', 'ignored'],
    ['bin/test.dll', 'native-content']
  ]));
  await extractNativeArchive(archivePath, destination, ['META-INF/']);
  assert.equal(await fs.readFile(path.join(destination, 'bin/test.dll'), 'utf8'), 'native-content');
  await assert.rejects(
    fs.access(path.join(destination, 'META-INF/MANIFEST.MF')),
    (error) => error.code === 'ENOENT'
  );

  const unsafeArchive = path.join(temporaryRoot, 'unsafe.jar');
  await fs.writeFile(unsafeArchive, storedZip([['../escape.dll', 'bad']]));
  await assert.rejects(extractNativeArchive(unsafeArchive, destination), /不安全/);
});

test('继承配置会合并参数并让子版本覆盖同名依赖', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-metadata-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeVersion(gameDirectory, '1.20.1', {
    mainClass: 'net.minecraft.client.main.Main',
    libraries: [{ name: 'example:shared:1.0' }],
    arguments: { game: ['--parent'], jvm: ['-Dparent=true'] }
  });
  await writeVersion(gameDirectory, 'fabric-test', {
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [
      { name: 'example:shared:2.0' },
      { name: 'example:loader:1.0' }
    ],
    arguments: { game: ['--child'], jvm: ['-Dchild=true'] }
  });

  const metadata = await readVersionMetadata(gameDirectory, 'fabric-test');
  assert.equal(metadata.clientJarId, '1.20.1');
  assert.equal(metadata.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.deepEqual(metadata.arguments.game, ['--parent', '--child']);
  assert.deepEqual(metadata.libraries.map((library) => library.name), [
    'example:shared:2.0',
    'example:loader:1.0'
  ]);
});

test('完整启动参数包含内存、继承类路径与离线账户信息', async (t) => {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-prepare-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  await writeVersion(gameDirectory, '1.20.1', {
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    javaVersion: { majorVersion: 17 },
    assetIndex: { id: '5' },
    libraries: [{
      name: 'example:shared:1.0',
      downloads: { artifact: { path: 'example/shared/1.0/shared-1.0.jar' } }
    }],
    arguments: {
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
      game: [
        '--username', '${auth_player_name}',
        '--uuid', '${auth_uuid}',
        '--accessToken', '${auth_access_token}'
      ]
    }
  });
  await writeVersion(gameDirectory, 'fabric-test', {
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{
      name: 'example:loader:1.0',
      downloads: { artifact: { path: 'example/loader/1.0/loader-1.0.jar' } }
    }],
    arguments: { game: ['--version', '${version_name}'] }
  });
  await writeFile(path.join(gameDirectory, 'libraries/example/shared/1.0/shared-1.0.jar'));
  await writeFile(path.join(gameDirectory, 'libraries/example/loader/1.0/loader-1.0.jar'));
  await writeFile(path.join(gameDirectory, 'versions/1.20.1/1.20.1.jar'));

  const configuredJavaPath = path.resolve(gameDirectory, 'custom-java', 'bin', 'java.exe');
  let requestedJavaPath;
  let requestedJavaVersion;
  const prepared = await prepareLaunch({
    gameDirectory,
    profileId: 'fabric-test',
    account: {
      type: 'offline',
      name: 'Steve',
      uuid: '5627dd98-e6be-3c21-b8a8-e92344183641',
      skinModel: 'alex'
    },
    memoryMb: 6144,
    javaPath: configuredJavaPath,
    findJava: async (explicitPath, majorVersion) => {
      requestedJavaPath = explicitPath;
      requestedJavaVersion = majorVersion;
      return 'java-test';
    }
  });

  assert.equal(requestedJavaPath, configuredJavaPath);
  assert.equal(requestedJavaVersion, 17);
  assert.equal(prepared.javaExecutable, 'java-test');
  assert.equal(prepared.mainClass, 'net.fabricmc.loader.impl.launch.knot.KnotClient');
  assert.ok(prepared.argumentsList.includes('-Xmx6144M'));
  assert.ok(prepared.argumentsList.includes('Steve'));
  assert.ok(prepared.argumentsList.includes(
    offlineUuidForSkinModel('5627dd98-e6be-3c21-b8a8-e92344183641', 'alex').replaceAll('-', '')
  ));
  assert.ok(prepared.argumentsList.includes('fabric-test'));
  const classpath = prepared.argumentsList[prepared.argumentsList.indexOf('-cp') + 1];
  assert.ok(classpath.includes('shared-1.0.jar'));
  assert.ok(classpath.includes('loader-1.0.jar'));
  assert.ok(classpath.includes(path.join('versions', '1.20.1', '1.20.1.jar')));

  const injectorPath = path.join(gameDirectory, 'launcher-cache', 'authlib-injector.jar');
  await writeFile(injectorPath);
  const yggdrasilPrepared = await prepareLaunch({
    gameDirectory,
    profileId: 'fabric-test',
    account: {
      type: 'yggdrasil',
      name: 'Player_01',
      uuid: '01234567-89ab-cdef-0123-456789abcdef',
      accessToken: 'little-access-token',
      clientToken: 'little-client-token'
    },
    authlibInjector: { path: injectorPath, server: 'littleskin.cn' },
    findJava: async () => 'java-test'
  });
  assert.ok(yggdrasilPrepared.argumentsList.includes(
    `-javaagent:${injectorPath}=littleskin.cn`
  ));
  assert.ok(yggdrasilPrepared.argumentsList.includes('little-access-token'));
});
