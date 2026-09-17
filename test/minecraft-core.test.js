const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  BMCLAPI_BASE,
  LSS233_LIBRARY_BASE,
  MinecraftSourceManager,
  OFFICIAL_MANIFEST,
  resolveSourceUrl
} = require('../src/main/minecraft/source-manager');
const {
  MinecraftDownloader,
  createDownloadProgressTracker,
  createDownloadSegments,
  downloadFile,
  hasValidInstallationMarker,
  isLibraryAllowed,
  mavenPathFromName,
  runPool,
  safePath
} = require('../src/main/minecraft/downloader');
const {
  MinecraftLoaderManager,
  fetchFastest,
  forgeLoaderVersions,
  forgeLoaderVersionsFromBmclapi,
  loaderArtifact,
  loaderProfileCandidates,
  neoForgeLoaderVersions,
  neoForgeVersionPrefix,
  parseMavenVersions
} = require('../src/main/minecraft/loader-manager');
const { buildInstallerArguments } = require('../src/main/minecraft/java-runtime');

test('BMCLAPI 与官方清单地址正确', () => {
  assert.equal(resolveSourceUrl('bmclapi', 'manifest', {}), `${BMCLAPI_BASE}/mc/game/version_manifest_v2.json`);
  assert.equal(resolveSourceUrl('official', 'manifest', {}), OFFICIAL_MANIFEST);
});

test('自动模式并行获取版本清单并采用先返回的来源', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requested = [];
  global.fetch = async (url) => {
    requested.push(url);
    const isOfficial = url === OFFICIAL_MANIFEST;
    await new Promise((resolve) => setTimeout(resolve, isOfficial ? 5 : 40));
    return new Response(JSON.stringify({
      latest: { release: isOfficial ? 'fast' : 'slow' },
      versions: []
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const manager = new MinecraftSourceManager();
  const result = await manager.getVersionManifest();
  assert.equal(result.source.id, 'official');
  assert.equal(result.manifest.latest.release, 'fast');
  assert.deepEqual(new Set(requested), new Set([
    `${BMCLAPI_BASE}/mc/game/version_manifest_v2.json`,
    OFFICIAL_MANIFEST
  ]));
});

test('BMCLAPI 版本、依赖库与资源地址正确', () => {
  assert.equal(
    resolveSourceUrl('bmclapi', 'version-json', { versionId: '1.21.5' }),
    `${BMCLAPI_BASE}/version/1.21.5/json`
  );
  assert.equal(
    resolveSourceUrl('bmclapi', 'library', { path: 'com/example/demo/1.0/demo-1.0.jar' }),
    `${BMCLAPI_BASE}/maven/com/example/demo/1.0/demo-1.0.jar`
  );
  assert.equal(
    resolveSourceUrl('bmclapi', 'asset', { hash: 'abcdef0123456789abcdef0123456789abcdef01' }),
    `${BMCLAPI_BASE}/assets/ab/abcdef0123456789abcdef0123456789abcdef01`
  );
});

test('自动模式会把 Lss233 聚合镜像加入依赖库候选地址', () => {
  const manager = new MinecraftSourceManager();
  const libraryPath = 'com/example/demo/1.0/demo-1.0.jar';
  const urls = manager.getCandidateUrls(
    'library',
    { path: libraryPath, originalUrl: `https://libraries.minecraft.net/${libraryPath}` },
    'official'
  );
  assert.equal(urls[0], `${BMCLAPI_BASE}/maven/${libraryPath}`);
  assert.ok(urls.includes(`${LSS233_LIBRARY_BASE}/${libraryPath}`));
});

test('Maven 坐标可以转换为依赖路径', () => {
  assert.equal(
    mavenPathFromName('org.example:demo:1.2.3'),
    'org/example/demo/1.2.3/demo-1.2.3.jar'
  );
});

test('库规则会排除不匹配的操作系统', () => {
  assert.equal(
    isLibraryAllowed({ rules: [{ action: 'allow', os: { name: '__not_current_platform__' } }] }),
    false
  );
  assert.equal(isLibraryAllowed({}), true);
});

test('下载目标不能逃出游戏目录', () => {
  const root = path.resolve('temporary-game-directory');
  assert.throws(() => safePath(root, '..', 'outside.jar'), /不安全/);
  assert.equal(safePath(root, 'versions', '1.21.5'), path.join(root, 'versions', '1.21.5'));
});

test('大文件可以被均匀拆分为多个并行下载段', () => {
  assert.deepEqual(createDownloadSegments(10, 3, 1), [
    { index: 0, start: 0, end: 3 },
    { index: 1, start: 4, end: 7 },
    { index: 2, start: 8, end: 9 }
  ]);
  assert.equal(createDownloadSegments(26 * 1024 * 1024, 8, 1024 * 1024).length, 8);
});

test('mixed known and unknown sizes never publish a partial byte denominator', () => {
  const tasks = [
    { destination: 'known', size: 100, label: 'Known file' },
    { destination: 'unknown', label: 'Unknown file' }
  ];
  const progress = [];
  const tracker = createDownloadProgressTracker({
    tasks,
    onProgress: (event) => progress.push(event),
    emitIntervalMs: 0
  });
  tracker.start('Starting');
  const hooks = tracker.hooks(tasks[1]);
  hooks.onBytes(120);
  assert.equal(progress.at(-1).completedBytes, 120);
  assert.equal(progress.at(-1).completedFiles, 0);
  assert.equal(progress.at(-1).totalBytes, 0);
  assert.equal(progress.at(-1).totalBytesKnown, false);
  assert.equal(progress.at(-1).etaSeconds, undefined);

  hooks.onTotalBytes(120);
  assert.equal(progress.at(-1).totalBytes, 220);
  assert.equal(progress.at(-1).totalBytesKnown, true);
  tracker.complete(tasks[1], { bytes: 120 });
  tracker.complete(tasks[0], { bytes: 100, skipped: true });
  assert.deepEqual(tracker.snapshot(), {
    completedFiles: 2,
    totalFiles: 2,
    completedBytes: 220,
    totalBytes: 220,
    totalBytesKnown: true
  });
});

test('retrying an unknown-size transfer discards the previous response length', () => {
  const task = { destination: 'retry', label: 'Retry file' };
  const progress = [];
  const tracker = createDownloadProgressTracker({
    tasks: [task],
    onProgress: (event) => progress.push(event),
    emitIntervalMs: 0
  });
  const hooks = tracker.hooks(task);
  hooks.onTotalBytes(100);
  hooks.onBytes(60);
  hooks.onBytes(0);
  assert.equal(progress.at(-1).completedBytes, 0);
  assert.equal(progress.at(-1).totalBytes, 0);
  assert.equal(progress.at(-1).totalBytesKnown, false);
  assert.equal(progress.at(-1).etaSeconds, undefined);
  hooks.onTotalBytes(200);
  hooks.onBytes(40);
  assert.equal(progress.at(-1).totalBytes, 200);
  assert.equal(progress.at(-1).completedBytes, 40);
});

test('cached unknown-size files contribute their actual size without network speed', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-cached-progress-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const destination = path.join(temporaryRoot, 'cached');
  const content = Buffer.from('cached file');
  await fs.writeFile(destination, content);
  const task = { destination, label: 'Cached file', urls: [] };
  const progress = [];
  const tracker = createDownloadProgressTracker({
    tasks: [task],
    onProgress: (event) => progress.push(event)
  });
  tracker.start('Starting');
  const result = await downloadFile({ ...task, ...tracker.hooks(task) });
  tracker.complete(task, result);
  assert.equal(result.skipped, true);
  assert.equal(result.bytes, content.length);
  assert.equal(progress.at(-1).completedBytes, content.length);
  assert.equal(progress.at(-1).totalBytes, content.length);
  assert.equal(progress.at(-1).totalBytesKnown, true);
  assert.equal(progress.at(-1).bytesPerSecond, 0);
});

test('unknown-size HTTP downloads learn an identity response length before receiving bytes', async (t) => {
  const content = Buffer.from('unknown-size download');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': content.length });
    response.end(content);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-http-progress-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const task = {
    destination: path.join(temporaryRoot, 'download'),
    label: 'Unknown file',
    urls: [`http://127.0.0.1:${server.address().port}/file`]
  };
  const progress = [];
  const tracker = createDownloadProgressTracker({
    tasks: [task],
    onProgress: (event) => progress.push(event),
    emitIntervalMs: 0
  });
  const hooks = tracker.hooks(task);
  const callbackOrder = [];
  const result = await downloadFile({
    ...task,
    ...hooks,
    onTotalBytes: (bytes) => {
      callbackOrder.push('total');
      hooks.onTotalBytes(bytes);
    },
    onBytes: (bytes) => {
      if (bytes > 0) callbackOrder.push('bytes');
      hooks.onBytes(bytes);
    }
  });
  tracker.complete(task, result);
  assert.equal(callbackOrder[0], 'total');
  assert.equal(callbackOrder.filter((event) => event === 'total').length, 1);
  assert.ok(callbackOrder.includes('bytes'));
  assert.ok(progress.some((event) => event.totalBytesKnown && event.completedBytes === 0));
  assert.equal(progress.at(-1).totalBytes, content.length);
  assert.equal(progress.at(-1).completedBytes, content.length);
  assert.deepEqual(await fs.readFile(task.destination), content);
});

test('encoded and partial HTTP response lengths are not treated as complete file sizes', async (t) => {
  const content = Buffer.from('decoded file data '.repeat(20));
  const encoded = require('node:zlib').gzipSync(content);
  const server = http.createServer((request, response) => {
    if (request.url === '/encoded') {
      response.writeHead(200, {
        'Content-Length': encoded.length,
        'Content-Encoding': 'gzip'
      });
      response.end(encoded);
    } else {
      response.writeHead(206, {
        'Content-Length': content.length,
        'Content-Range': `bytes 0-${content.length - 1}/${content.length * 2}`
      });
      response.end(content);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-header-progress-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  for (const route of ['encoded', 'partial']) {
    const totals = [];
    const result = await downloadFile({
      destination: path.join(temporaryRoot, route),
      label: route,
      urls: [`http://127.0.0.1:${server.address().port}/${route}`],
      onTotalBytes: (bytes) => totals.push(bytes)
    });
    assert.deepEqual(totals, []);
    assert.equal(result.bytes, content.length);
  }
});

test('loader installation publishes complete only after the loader has finished', async () => {
  const progress = [];
  let markLoaderStarted;
  let finishLoader;
  const loaderStarted = new Promise((resolve) => { markLoaderStarted = resolve; });
  const loaderFinished = new Promise((resolve) => { finishLoader = resolve; });
  const manager = new MinecraftLoaderManager({
    gameDirectory: 'game',
    sourceManager: {},
    downloader: {
      async installVersion(_version, onProgress) {
        onProgress({ phase: 'preparing', message: 'Preparing base' });
        onProgress({ phase: 'downloading', completedFiles: 1, totalFiles: 2 });
        onProgress({ phase: 'complete', completedFiles: 2, totalFiles: 2 });
        return { source: 'official' };
      }
    }
  });
  manager.validateLoaderVersion = async () => ({ entry: {}, source: { id: 'official' } });
  manager.installFabric = async () => {
    markLoaderStarted();
    await loaderFinished;
    return { profileId: 'fabric-test', totalFiles: 3 };
  };
  const installation = manager.installLoader({
    gameVersion: '1.21.5', loaderType: 'fabric', loaderVersion: '0.16.14'
  }, (event) => progress.push(event));
  await loaderStarted;
  assert.equal(progress.some((event) => event.phase === 'complete'), false);
  assert.ok(progress.some((event) => event.phase === 'preparing-base'));
  assert.ok(progress.some((event) => event.phase === 'downloading-base' && event.completedFiles === 1));
  assert.equal(progress.at(-1).phase, 'base-ready');
  assert.equal(progress.at(-1).completedFiles, 2);
  finishLoader();
  await installation;
  assert.equal(progress.filter((event) => event.phase === 'complete').length, 1);
  assert.equal(progress.at(-1).phase, 'complete');
  assert.equal(progress.at(-1).completedFiles, 3);
});

test('vanilla installation retains the downloader completion event', async () => {
  const progress = [];
  const manager = new MinecraftLoaderManager({
    gameDirectory: 'game',
    sourceManager: {},
    downloader: {
      async installVersion(_version, onProgress) {
        onProgress({ phase: 'complete', completedFiles: 2, totalFiles: 2 });
        return { versionId: '1.21.5' };
      }
    }
  });
  await manager.installLoader({ gameVersion: '1.21.5', loaderType: 'vanilla' },
    (event) => progress.push(event));
  assert.equal(progress.length, 1);
  assert.equal(progress[0].phase, 'complete');
});

test('任务池收到取消信号后立即停止派发任务', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runPool([1, 2, 3], 2, async () => {}, controller.signal),
    (error) => error.name === 'AbortError' && error.message === '下载已取消'
  );
});

test('大文件使用 HTTP Range 分段下载并完成校验', async (t) => {
  const content = Buffer.alloc(13 * 1024 * 1024, 0x5a);
  const requestedRanges = [];
  const server = http.createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      requestedRanges.push([start, end]);
      response.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${content.length}`
      });
      response.end(content.subarray(start, end + 1));
      return;
    }
    response.writeHead(200, { 'Content-Length': content.length });
    response.end(content);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-range-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const destination = path.join(temporaryRoot, 'client.jar');
  const address = server.address();
  const result = await downloadFile({
    label: '分段测试文件',
    destination,
    urls: [`http://127.0.0.1:${address.port}/client.jar`],
    size: content.length,
    sha1: crypto.createHash('sha1').update(content).digest('hex'),
    segmentConcurrency: 4
  });

  assert.equal(result.segmented, true);
  assert.equal(result.segments, 4);
  assert.equal((await fs.stat(destination)).size, content.length);
  assert.equal(requestedRanges.length, 5);
});

test('取消文件流后清理临时文件', async (t) => {
  const totalSize = 1024 * 1024;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': totalSize });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= totalSize) {
        clearInterval(timer);
        response.end();
        return;
      }
      const chunk = Buffer.alloc(Math.min(64 * 1024, totalSize - sent), 0x31);
      sent += chunk.length;
      response.write(chunk);
    }, 10);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-cancel-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const destination = path.join(temporaryRoot, 'client.jar');
  const controller = new AbortController();
  const address = server.address();
  const download = downloadFile({
    label: '取消测试文件',
    destination,
    urls: [`http://127.0.0.1:${address.port}/client.jar`],
    size: totalSize,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 35);

  await assert.rejects(
    download,
    (error) => error.name === 'AbortError' && error.message === '下载已取消'
  );
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${destination}.part`), { code: 'ENOENT' });
});

test('小文件长时间无数据时切换备用地址', { timeout: 5000 }, async (t) => {
  const content = Buffer.alloc(64 * 1024, 0x42);
  const requested = [];
  const server = http.createServer((request, response) => {
    requested.push(request.url);
    response.writeHead(200, { 'Content-Length': content.length });
    if (request.url === '/stall') {
      response.write(content.subarray(0, 1));
      return;
    }
    response.end(content);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-idle-fallback-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const destination = path.join(temporaryRoot, 'asset');
  const address = server.address();
  const switches = [];
  const result = await downloadFile({
    label: '停滞小文件',
    destination,
    urls: [
      `http://127.0.0.1:${address.port}/stall`,
      `http://127.0.0.1:${address.port}/fast`
    ],
    size: content.length,
    sha1: crypto.createHash('sha1').update(content).digest('hex'),
    idleTimeoutMs: 80,
    signal: AbortSignal.timeout(3000),
    onSourceSwitch: (event) => switches.push(event)
  });

  assert.deepEqual(requested, ['/stall', '/fast']);
  assert.equal(result.url, `http://127.0.0.1:${address.port}/fast`);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].reason, 'idle');
  assert.deepEqual(await fs.readFile(destination), content);
  await assert.rejects(fs.stat(`${destination}.part`), { code: 'ENOENT' });
});

test('唯一地址停滞时结束下载并清理临时文件', { timeout: 5000 }, async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': 64 * 1024 });
    response.write(Buffer.from('x'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-idle-cleanup-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const destination = path.join(temporaryRoot, 'asset');
  const address = server.address();

  await assert.rejects(downloadFile({
    label: '唯一停滞地址',
    destination,
    urls: [`http://127.0.0.1:${address.port}/stall`],
    size: 64 * 1024,
    idleTimeoutMs: 80,
    signal: AbortSignal.timeout(3000)
  }), /下载连接长时间无数据/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
  await assert.rejects(fs.stat(`${destination}.part`), { code: 'ENOENT' });
});

test('持续有数据的慢速连接可以超过无数据超时完成下载', { timeout: 5000 }, async (t) => {
  const content = Buffer.alloc(24 * 1024, 0x31);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Length': content.length });
    let sent = 0;
    const timer = setInterval(() => {
      const chunk = content.subarray(sent, sent + 1024);
      sent += chunk.length;
      response.write(chunk);
      if (sent >= content.length) {
        clearInterval(timer);
        response.end();
      }
    }, 20);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-idle-progress-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const destination = path.join(temporaryRoot, 'asset');
  const address = server.address();
  const result = await downloadFile({
    label: '持续慢速下载',
    destination,
    urls: [`http://127.0.0.1:${address.port}/slow`],
    size: content.length,
    sha1: crypto.createHash('sha1').update(content).digest('hex'),
    idleTimeoutMs: 100,
    signal: AbortSignal.timeout(3000)
  });

  assert.equal(result.bytes, content.length);
  assert.deepEqual(await fs.readFile(destination), content);
});

test('只有完整文件检测通过后版本才会标记为已安装', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-verify-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const versionId = '1.0-test';
  const versionRoot = path.join(temporaryRoot, 'versions', versionId);
  await fs.mkdir(versionRoot, { recursive: true });
  const client = Buffer.from('complete-client');
  const metadata = {
    id: versionId,
    libraries: [],
    downloads: {
      client: {
        sha1: crypto.createHash('sha1').update(client).digest('hex'),
        size: client.length
      }
    }
  };
  await fs.writeFile(
    path.join(versionRoot, `${versionId}.json`),
    JSON.stringify(metadata),
    'utf8'
  );
  const downloader = new MinecraftDownloader({
    gameDirectory: temporaryRoot,
    sourceManager: new MinecraftSourceManager(),
    concurrency: 4
  });

  const incomplete = await downloader.verifyVersion(versionId);
  assert.equal(incomplete.complete, false);
  assert.equal(await hasValidInstallationMarker(temporaryRoot, versionId), false);

  await fs.writeFile(path.join(versionRoot, `${versionId}.jar`), client);
  const complete = await downloader.verifyVersion(versionId);
  assert.equal(complete.complete, true);
  assert.equal(await hasValidInstallationMarker(temporaryRoot, versionId), true);
});

test('真实下载测速按收到的字节和耗时计算吞吐量', async (t) => {
  const content = Buffer.alloc(256 * 1024, 0x42);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Length': content.length });
    if (request.url === '/fast') {
      response.end(content);
      return;
    }
    let offset = 0;
    const timer = setInterval(() => {
      const chunk = content.subarray(offset, offset + 32 * 1024);
      offset += chunk.length;
      response.write(chunk);
      if (offset >= content.length) {
        clearInterval(timer);
        response.end();
      }
    }, 18);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const manager = new MinecraftSourceManager({ benchmarkTimeoutMs: 2000 });
  const fast = await manager.benchmarkUrl(`http://127.0.0.1:${address.port}/fast`, {
    sampleBytes: 128 * 1024
  });
  const slow = await manager.benchmarkUrl(`http://127.0.0.1:${address.port}/slow`, {
    sampleBytes: 128 * 1024
  });
  const parallel = await manager.benchmarkSource(`http://127.0.0.1:${address.port}/fast`);
  assert.equal(fast.bytes, 128 * 1024);
  assert.equal(slow.bytes, 128 * 1024);
  assert.ok(fast.bytesPerSecond > slow.bytesPerSecond);
  assert.equal(parallel.connections, 3);
  assert.equal(parallel.bytes, 3 * 128 * 1024);
});

test('持续低速时中止当前源并切换备用地址', async (t) => {
  const content = Buffer.alloc(512 * 1024, 0x37);
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Length': content.length });
    if (request.url === '/fast') {
      response.end(content);
      return;
    }
    let offset = 0;
    const timer = setInterval(() => {
      const chunk = content.subarray(offset, offset + 1 * 1024);
      offset += chunk.length;
      response.write(chunk);
      if (offset >= content.length) {
        clearInterval(timer);
        response.end();
      }
    }, 30);
    response.once('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-source-switch-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const address = server.address();
  const destination = path.join(temporaryRoot, 'client.jar');
  const switches = [];
  const result = await downloadFile({
    label: '低速换源测试',
    destination,
    urls: [
      `http://127.0.0.1:${address.port}/slow`,
      `http://127.0.0.1:${address.port}/fast`
    ],
    size: content.length,
    sha1: crypto.createHash('sha1').update(content).digest('hex'),
    slowMinimumSize: 1,
    slowGraceMs: 200,
    slowCheckIntervalMs: 40,
    slowThresholdBytesPerSecond: 200 * 1024,
    onSourceSwitch: (event) => switches.push(event)
  });

  assert.equal(result.url, `http://127.0.0.1:${address.port}/fast`);
  assert.equal(switches.length, 1);
  assert.equal((await fs.stat(destination)).size, content.length);
  await assert.rejects(fs.stat(`${destination}.part`), { code: 'ENOENT' });
});

test('Maven 元数据可以解析 Forge 与 NeoForge 版本', () => {
  const xml = '<versions><version>1.21.1-52.1.15</version><version>1.21.1-52.1.16</version><version>21.1.243</version></versions>';
  const versions = parseMavenVersions(xml);
  assert.deepEqual(
    forgeLoaderVersions('1.21.1', versions).map((entry) => entry.version),
    ['52.1.16', '52.1.15']
  );
  assert.deepEqual(
    neoForgeLoaderVersions('1.21.1', versions).map((entry) => entry.version),
    ['21.1.243']
  );
});

test('自动模式并行获取加载器版本并采用先返回的有效来源', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requested = [];
  global.fetch = (url, { signal } = {}) => new Promise((resolve, reject) => {
    requested.push(url);
    const fast = url.endsWith('/fast');
    const timer = setTimeout(() => resolve(new Response(
      JSON.stringify({ version: fast ? 'fast' : 'slow' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )), fast ? 5 : 100);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      const error = new Error('请求已取消');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  const result = await fetchFastest([
    { source: { id: 'slow' }, url: 'https://loader.test/slow' },
    { source: { id: 'fast' }, url: 'https://loader.test/fast' }
  ], (response) => response.json());

  assert.equal(result.source.id, 'fast');
  assert.equal(result.data.version, 'fast');
  assert.deepEqual(new Set(requested), new Set([
    'https://loader.test/slow',
    'https://loader.test/fast'
  ]));
});

test('BMCLAPI Forge 列表只保留带 installer 的当前游戏版本', () => {
  const records = [
    { mcversion: '1.21.1', version: '52.1.16', files: [{ category: 'installer', format: 'jar' }] },
    { mcversion: '1.21.1', version: '52.1.15', files: [{ category: 'mdk', format: 'zip' }] },
    { mcversion: '1.20.1', version: '47.3.22', files: [{ category: 'installer', format: 'jar' }] }
  ];
  assert.deepEqual(
    forgeLoaderVersionsFromBmclapi('1.21.1', records).map((entry) => entry.version),
    ['52.1.16']
  );
});

test('NeoForge 版本前缀兼容传统与新版 Minecraft 版本号', () => {
  assert.equal(neoForgeVersionPrefix('1.21.1'), '21.1.');
  assert.equal(neoForgeVersionPrefix('26.2'), '26.2.');
});

test('Forge 与 NeoForge 安装器地址正确', () => {
  assert.deepEqual(loaderArtifact('forge', '1.20.1', '47.3.22'), {
    artifactVersion: '1.20.1-47.3.22',
    path: 'net/minecraftforge/forge/1.20.1-47.3.22/forge-1.20.1-47.3.22-installer.jar',
    officialUrl: 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.3.22/forge-1.20.1-47.3.22-installer.jar'
  });
  assert.equal(
    loaderArtifact('neoforge', '1.21.1', '21.1.243').officialUrl,
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.243/neoforge-21.1.243-installer.jar'
  );
});

test('加载器启动配置 ID 和 Java 安装参数正确', () => {
  assert.deepEqual(
    loaderProfileCandidates('fabric', '1.21.1', '0.16.10'),
    ['fabric-loader-0.16.10-1.21.1']
  );
  assert.deepEqual(
    loaderProfileCandidates('neoforge', '1.21.1', '21.1.243'),
    ['1.21.1-neoforge-21.1.243', 'neoforge-21.1.243']
  );
  assert.deepEqual(
    buildInstallerArguments('C:\\cache\\forge-installer.jar', 'C:\\.minecraft'),
    ['-jar', 'C:\\cache\\forge-installer.jar', '--installClient', 'C:\\.minecraft']
  );
});
