const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { fetchWithTimeout } = require('../src/main/minecraft/source-manager');
const { extractNativeArchive } = require('../src/main/minecraft/launch-core');
const { downloadModpackFile } = require('../src/main/minecraft/modpack-download-cache');
const {
  ModpackManager,
  createInstanceId,
  parseCurseForgeManifest,
  parseModrinthIndex,
  publicPackInfo,
  resolveCurseForgeFile,
  safeRelativePath,
  validatePublicDownloadUrl
} = require('../src/main/minecraft/modpack-manager');

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [entryName, value] of entries) {
    const name = Buffer.from(entryName);
    const content = Buffer.from(value?.content ?? value);
    const method = value?.method ?? 0;
    const compressed = method === 8 ? zlib.deflateRawSync(content) : content;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
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
      },
      {
        path: 'mods/optional.jar',
        downloads: ['https://cdn.modrinth.com/data/optional.jar'],
        env: { client: 'optional' }
      }
    ]
  });
  assert.equal(pack.format, 'modrinth');
  assert.equal(pack.gameVersion, '1.21.1');
  assert.equal(pack.loaderType, 'fabric');
  assert.equal(pack.loaderVersion, '0.16.10');
  assert.equal(pack.files.length, 2);
  assert.equal(pack.files[0].path, 'mods/example.jar');
  assert.equal(pack.files[0].required, true);
  assert.equal(pack.files[1].path, 'mods/optional.jar');
  assert.equal(pack.files[1].required, false);
});

test('inspect 会区分必需与可选整合包文件数量', () => {
  const pack = parseModrinthIndex({
    formatVersion: 1,
    game: 'minecraft',
    name: 'Optional Pack',
    versionId: '1.0.0',
    dependencies: { minecraft: '1.21.1' },
    files: [
      {
        path: 'mods/required.jar',
        downloads: ['https://cdn.modrinth.com/data/required.jar'],
        env: { client: 'required' }
      },
      {
        path: 'mods/optional.jar',
        downloads: ['https://cdn.modrinth.com/data/optional.jar'],
        env: { client: 'optional' }
      }
    ]
  });
  const info = publicPackInfo(pack);
  assert.equal(info.fileCount, 2);
  assert.equal(info.requiredFileCount, 1);
  assert.equal(info.optionalFileCount, 1);
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

test('整合包下载地址拒绝私有网段、回环 IPv6 和带凭据的 URL', async () => {
  const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
  await assert.rejects(validatePublicDownloadUrl('https://172.20.0.4/file.jar'));
  await assert.rejects(validatePublicDownloadUrl('https://[::1]/file.jar'));
  await assert.rejects(validatePublicDownloadUrl('https://user:pass@example.com/file.jar'));
  await assert.rejects(validatePublicDownloadUrl('https://pack.example/file.jar', async () => [
    { address: '192.168.1.8', family: 4 }
  ]));
  assert.equal(await validatePublicDownloadUrl('https://pack.example/file.jar', publicLookup),
    'https://pack.example/file.jar');
});

test('整合包下载重定向会在请求目标前重新校验', async (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests += 1;
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  });
  await assert.rejects(fetchWithTimeout('https://pack.example/file.jar', {
    validateRedirect: (url) => validatePublicDownloadUrl(url, async () => [
      { address: '8.8.8.8', family: 4 }
    ])
  }), /不安全/);
  assert.equal(requests, 1);
});

test('ZIP 解压限制单个条目的解压大小', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-limit-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const archivePath = path.join(temporaryRoot, 'large-entry.zip');
  await fs.writeFile(archivePath, storedZip([['large.bin', '12345']]));
  await assert.rejects(
    extractNativeArchive(archivePath, path.join(temporaryRoot, 'out'), [], { maxEntryBytes: 4 }),
    /单个文件过大/
  );
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
    fileCount: 0,
    requiredFileCount: 0,
    optionalFileCount: 0
  });
});

test('Quilt 整合包预览会在下载前验证游戏与加载器版本组合', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-quilt-preflight-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'quilt.mrpack');
  await fs.writeFile(archivePath, storedZip([['modrinth.index.json', JSON.stringify({
    formatVersion: 1, game: 'minecraft', name: 'Quilt Preview', versionId: '1',
    dependencies: { minecraft: '1.20.1', 'quilt-loader': '0.26.4' }, files: []
  })]]));
  const calls = [];
  const manager = new ModpackManager({ gameDirectory: root, loaderManager: {
    validateLoaderVersion: async (...args) => calls.push(args)
  } });
  assert.equal((await manager.inspect(archivePath)).loaderType, 'quilt');
  assert.deepEqual(calls[0].slice(0, 3), ['1.20.1', 'quilt', '0.26.4']);
  manager.loaderManager.validateLoaderVersion = async () => { throw new Error('版本不存在'); };
  await assert.rejects(manager.inspect(archivePath), error => (
    error.code === 'MODPACK_LOADER_INCOMPATIBLE' && error.retryable === false
  ));
});

test('预览仅读取压缩清单，不展开整合包覆盖文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-preview-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'wrapped.mrpack');
  const index = {
    formatVersion: 1, game: 'minecraft', name: 'Wrapped Pack',
    dependencies: { minecraft: '1.21.1' }, files: []
  };
  const archive = storedZip([
    ['wrapped/modrinth.index.json', { content: JSON.stringify(index), method: 8 }],
    ['wrapped/overrides/unused.txt', 'invalid deflate payload']
  ]);
  // A broken override still permits a manifest preview, but must fail when
  // installed. This also ensures preview never inflates unrelated entries.
  const endOffset = archive.length - 22;
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const firstRecordSize = 46 + archive.readUInt16LE(centralOffset + 28);
  const secondRecord = centralOffset + firstRecordSize;
  const secondLocal = archive.readUInt32LE(secondRecord + 42);
  archive.writeUInt16LE(8, secondRecord + 10);
  archive.writeUInt16LE(8, secondLocal + 8);
  await fs.writeFile(archivePath, archive);
  const manager = new ModpackManager({ gameDirectory: root, loaderManager: {} });
  assert.equal((await manager.inspect(archivePath)).name, 'Wrapped Pack');
  await assert.rejects(manager.install(archivePath));
});

test('预览拒绝过大的清单、不安全路径和损坏的目录边界', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-preview-limits-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'unsafe.mrpack');
  const manager = new ModpackManager({ gameDirectory: root, loaderManager: {} });
  const archive = storedZip([['modrinth.index.json', '{}']]);
  const centralOffset = archive.readUInt32LE(archive.length - 22 + 16);
  archive.writeUInt32LE(4 * 1024 * 1024 + 1, centralOffset + 24);
  await fs.writeFile(archivePath, archive);
  await assert.rejects(manager.inspect(archivePath), /清单过大/);

  await fs.writeFile(archivePath, storedZip([
    ['modrinth.index.json', '{}'], ['overrides/../../escape', 'x']
  ]));
  await assert.rejects(manager.inspect(archivePath), /不安全/);

  const broken = storedZip([['modrinth.index.json', '{}']]);
  broken.writeUInt32LE(0xffffffff - 1, broken.length - 22 + 16);
  await fs.writeFile(archivePath, broken);
  await assert.rejects(manager.inspect(archivePath), /损坏/);
});

test('预览拒绝清单解压炸弹，即使目录谎报解压大小', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-manifest-bomb-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'bomb.mrpack');
  const archive = storedZip([
    ['modrinth.index.json', { content: ' '.repeat(4 * 1024 * 1024 + 1), method: 8 }]
  ]);
  const centralOffset = archive.readUInt32LE(archive.length - 22 + 16);
  archive.writeUInt32LE(2, centralOffset + 24);
  await fs.writeFile(archivePath, archive);
  const manager = new ModpackManager({ gameDirectory: root, loaderManager: {} });
  await assert.rejects(manager.inspect(archivePath), /larger than|大小|length/i);
});

test('Modrinth 安装先下载索引文件，再应用通用与客户端覆盖文件', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-overrides-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const archivePath = path.join(temporaryRoot, 'overrides.mrpack');
  const downloadedContent = 'downloaded configuration';
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    name: 'Override Pack',
    dependencies: { minecraft: '1.21.1' },
    files: ['common.txt', 'client.txt', 'download-only.txt'].map((name) => ({
      path: `config/${name}`,
      downloads: [`https://cdn.modrinth.com/data/${name}`],
      hashes: { sha1: crypto.createHash('sha1').update(downloadedContent).digest('hex') },
      fileSize: Buffer.byteLength(downloadedContent)
    }))
  };
  await fs.writeFile(archivePath, storedZip([
    ['modrinth.index.json', JSON.stringify(index)],
    ['overrides/config/common.txt', 'common override'],
    ['overrides/config/client.txt', 'common client configuration'],
    ['client-overrides/config/client.txt', 'client override']
  ]));
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    downloads += 1;
    return new Response(downloadedContent);
  });
  const manager = new ModpackManager({
    gameDirectory: path.join(temporaryRoot, 'game'),
    loaderManager: { installLoader: async () => ({ profileId: '1.21.1' }) },
    lookupHost: async () => [{ address: '8.8.8.8', family: 4 }]
  });

  const result = await manager.install(archivePath);
  const configurationRoot = path.join(manager.gameDirectory, 'melody-instances', result.instanceId, 'config');
  assert.equal(downloads, 1); // Identical hash-checked content shares one download.
  assert.equal(await fs.readFile(path.join(configurationRoot, 'common.txt'), 'utf8'), 'common override');
  assert.equal(await fs.readFile(path.join(configurationRoot, 'client.txt'), 'utf8'), 'client override');
  assert.equal(await fs.readFile(path.join(configurationRoot, 'download-only.txt'), 'utf8'), downloadedContent);
});

test('整合包安装失败保留校验后的下载，重试复用并重新检查缓存', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-retry-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'retry.mrpack');
  const content = { 'first.jar': 'first downloaded jar', 'second.jar': 'second downloaded jar' };
  const hashes = Object.fromEntries(Object.entries(content).map(([name, value]) => [
    name, crypto.createHash('sha1').update(value).digest('hex')
  ]));
  const index = {
    formatVersion: 1, game: 'minecraft', name: 'Retry Pack',
    dependencies: { minecraft: '1.21.1' },
    files: Object.entries(content).map(([name, value]) => ({
      path: `mods/${name}`, hashes: { sha1: hashes[name] }, fileSize: Buffer.byteLength(value),
      downloads: [`https://cdn.modrinth.com/data/${name}`]
    }))
  };
  await fs.writeFile(archivePath, storedZip([['modrinth.index.json', JSON.stringify(index)]]));
  const counts = { 'first.jar': 0, 'second.jar': 0 };
  let failSecond = true;
  t.mock.method(globalThis, 'fetch', async (url) => {
    const name = new URL(url).pathname.split('/').at(-1);
    counts[name] += 1;
    return failSecond && name === 'second.jar'
      ? new Response(null, { status: 503 })
      : new Response(content[name]);
  });
  const manager = new ModpackManager({
    gameDirectory: path.join(root, 'game'), concurrency: 1,
    loaderManager: { installLoader: async () => ({ profileId: '1.21.1' }) },
    lookupHost: async () => [{ address: '8.8.8.8', family: 4 }]
  });
  await assert.rejects(manager.install(archivePath), /下载失败/);
  const cacheRoot = path.join(manager.gameDirectory, 'launcher-cache', 'modpack-files');
  assert.equal(await fs.readFile(path.join(cacheRoot, hashes['first.jar']), 'utf8'), content['first.jar']);
  assert.deepEqual(await fs.readdir(path.join(manager.gameDirectory, 'melody-instances')), []);
  assert.deepEqual(await fs.readdir(cacheRoot), [hashes['first.jar']]);

  failSecond = false;
  const retry = await manager.install(archivePath);
  // second.jar 每轮先试 MCIM 镜像再回退官方直链，失败轮次会各请求一次。
  assert.deepEqual(counts, { 'first.jar': 1, 'second.jar': 3 });
  assert.equal(await fs.readFile(path.join(manager.gameDirectory, 'melody-instances',
    retry.instanceId, 'mods', 'first.jar'), 'utf8'), content['first.jar']);

  // Same-length tampering must cause a fresh download rather than a cache hit.
  await fs.writeFile(path.join(cacheRoot, hashes['first.jar']), 'x'.repeat(content['first.jar'].length));
  const recovered = await manager.install(archivePath);
  assert.deepEqual(counts, { 'first.jar': 2, 'second.jar': 3 });
  assert.equal(await fs.readFile(path.join(manager.gameDirectory, 'melody-instances',
    recovered.instanceId, 'mods', 'first.jar'), 'utf8'), content['first.jar']);
});

test('取消整合包安装保留已完成的缓存，重试继续下载剩余文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-cancel-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, 'cancel.mrpack');
  const index = {
    formatVersion: 1, game: 'minecraft', name: 'Cancel Pack',
    dependencies: { minecraft: '1.21.1' },
    files: ['first.jar', 'second.jar'].map((name) => ({
      path: `mods/${name}`, downloads: [`https://cdn.modrinth.com/data/${name}`],
      hashes: { sha1: crypto.createHash('sha1').update(name).digest('hex') },
      fileSize: Buffer.byteLength(name)
    }))
  };
  await fs.writeFile(archivePath, storedZip([['modrinth.index.json', JSON.stringify(index)]]));
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const name = new URL(url).pathname.split('/').at(-1);
    requested.push(name);
    return new Response(name);
  });
  const manager = new ModpackManager({
    gameDirectory: path.join(root, 'game'), concurrency: 1,
    loaderManager: { installLoader: async () => ({ profileId: '1.21.1' }) },
    lookupHost: async () => [{ address: '8.8.8.8', family: 4 }]
  });
  const controller = new AbortController();
  await assert.rejects(manager.install(archivePath, (progress) => {
    if (progress.phase === 'downloading-files' && progress.completedFiles === 1) controller.abort();
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(requested, ['first.jar']);
  assert.deepEqual(await fs.readdir(path.join(manager.gameDirectory, 'melody-instances')), []);
  await manager.install(archivePath);
  assert.deepEqual(requested, ['first.jar', 'second.jar']);
});

test('没有可信哈希或校验失败的下载不会进入可复用整合包缓存', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-modpack-unverified-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cacheRoot = path.join(root, 'cache');
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    downloads += 1;
    return new Response('downloaded content');
  });
  const task = { label: 'test', urls: ['https://cdn.modrinth.com/data/unverified.jar'] };
  await downloadModpackFile({ ...task, destination: path.join(root, 'attempt-one', 'mod.jar') }, cacheRoot);
  await downloadModpackFile({ ...task, destination: path.join(root, 'attempt-two', 'mod.jar') }, cacheRoot);
  assert.equal(downloads, 2);
  await assert.rejects(fs.stat(cacheRoot), { code: 'ENOENT' });

  await assert.rejects(downloadModpackFile({
    ...task, destination: path.join(root, 'bad-hash.jar'), sha1: '0'.repeat(40)
  }, cacheRoot), /校验失败/);
  assert.deepEqual(await fs.readdir(cacheRoot), []);
});

test('CurseForge 文件缺少下载地址时给出受限提示', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: { fileName: 'restricted.jar', downloadUrl: null, hashes: [] } })
  });
  try {
    await assert.rejects(
      resolveCurseForgeFile({ projectId: 42, fileId: 100, required: true }, undefined),
      /禁止第三方自动下载/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Modrinth 文件地址优先使用 MCIM 镜像，官方直链保留回退', () => {
  const pack = parseModrinthIndex({
    formatVersion: 1,
    game: 'minecraft',
    name: 'Mirror Pack',
    dependencies: { minecraft: '1.21.1' },
    files: [
      {
        path: 'mods/example.jar',
        hashes: { sha1: '0123456789abcdef0123456789abcdef01234567' },
        downloads: ['https://cdn.modrinth.com/data/example.jar'],
        fileSize: 12
      },
      { path: 'mods/other.jar', downloads: ['https://example.com/other.jar'] }
    ]
  });
  assert.deepEqual(pack.files[0].urls, [
    'https://mod.mcimirror.top/data/example.jar',
    'https://cdn.modrinth.com/data/example.jar'
  ]);
  assert.deepEqual(pack.files[1].urls, ['https://example.com/other.jar']);
});

test('CurseForge 文件地址同样优先使用 MCIM 镜像', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      data: {
        fileName: 'mirror.jar',
        downloadUrl: 'https://mediafilez.forgecdn.net/files/1234/mirror.jar',
        hashes: []
      }
    })
  });
  try {
    const file = await resolveCurseForgeFile({ projectId: 42, fileId: 100, required: true }, undefined);
    assert.deepEqual(file.urls, [
      'https://mod.mcimirror.top/files/1234/mirror.jar',
      'https://mediafilez.forgecdn.net/files/1234/mirror.jar'
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('CurseForge 接口不可达时给出文件下架提示', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    await assert.rejects(
      resolveCurseForgeFile({ projectId: 42, fileId: 100, required: true }, undefined),
      /无法获取 CurseForge 文件信息/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
