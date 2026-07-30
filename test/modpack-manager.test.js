const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  ModpackManager,
  createInstanceId,
  parseCurseForgeManifest,
  parseModrinthIndex,
  safeRelativePath
} = require('../src/main/minecraft/modpack-manager');

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

test('Modrinth 索引会解析客户端文件并识别加载器', () => {
  const pack = parseModrinthIndex({
    formatVersion: 1,
    game: 'minecraft',
    name: 'Fabric Pack',
    versionId: '1.0.0',
    dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.10' },
    files: [
      {
        path: 'mods/example.jar',
        hashes: { sha1: '0123456789abcdef0123456789abcdef01234567' },
        downloads: ['https://cdn.modrinth.com/data/example.jar'],
        fileSize: 12
      },
      {
        path: 'mods/server-only.jar',
        downloads: ['https://cdn.modrinth.com/data/server-only.jar'],
        env: { client: 'unsupported' }
      }
    ]
  });
  assert.equal(pack.format, 'modrinth');
  assert.equal(pack.gameVersion, '1.21.1');
  assert.equal(pack.loaderType, 'fabric');
  assert.equal(pack.loaderVersion, '0.16.10');
  assert.equal(pack.files.length, 1);
  assert.equal(pack.files[0].path, 'mods/example.jar');
});

test('CurseForge 清单会解析游戏、加载器与文件编号', () => {
  const pack = parseCurseForgeManifest({
    manifestType: 'minecraftModpack',
    name: 'Forge Pack',
    version: '2.0',
    minecraft: {
      version: '1.20.1',
      modLoaders: [{ id: 'forge-47.3.0', primary: true }]
    },
    files: [{ projectID: 123, fileID: 456, required: true }],
    overrides: 'overrides'
  });
  assert.equal(pack.format, 'curseforge');
  assert.equal(pack.gameVersion, '1.20.1');
  assert.equal(pack.loaderType, 'forge');
  assert.equal(pack.loaderVersion, '47.3.0');
  assert.deepEqual(pack.files, [{ projectId: 123, fileId: 456, required: true }]);
});

test('整合包路径必须留在实例目录内', () => {
  assert.equal(safeRelativePath('mods/example.jar'), 'mods/example.jar');
  assert.throws(() => safeRelativePath('../outside.jar'), /不安全/);
  assert.throws(() => safeRelativePath('C:\\outside.jar'), /不安全/);
});

test('实例 ID 是可启动且稳定格式的安全标识', () => {
  assert.equal(createInstanceId('My Fancy Pack!', 123456), 'My-Fancy-Pack-2n9c');
  assert.match(createInstanceId('冒险整合包', 1), /^modpack-[0-9a-z]+$/);
});

test('可以从最小 mrpack 压缩包读取安装信息', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-inspect-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const archivePath = path.join(temporaryRoot, 'minimal.mrpack');
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    name: 'Minimal Pack',
    versionId: '1.0.0',
    dependencies: { minecraft: '1.21.1' },
    files: []
  };
  await fs.writeFile(archivePath, storedZip([
    ['modrinth.index.json', JSON.stringify(index)]
  ]));

  const manager = new ModpackManager({ gameDirectory: temporaryRoot, loaderManager: {} });
  const info = await manager.inspect(archivePath);
  assert.deepEqual(info, {
    format: 'modrinth',
    name: 'Minimal Pack',
    version: '1.0.0',
    gameVersion: '1.21.1',
    loaderType: 'vanilla',
    loaderVersion: '1.21.1',
    fileCount: 0
  });
});
