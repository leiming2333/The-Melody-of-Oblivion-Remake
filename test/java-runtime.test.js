const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  detectJava,
  discoverJavaCandidates,
  findJavaExecutable,
  javaMajorFromVersionOutput
} = require('../src/main/minecraft/java-runtime');
const {
  ManagedJavaRuntime,
  AZUL_API,
  adoptiumArchitecture,
  adoptiumPlatform,
  selectRuntimePackage,
  selectZuluRuntimePackage
} = require('../src/main/minecraft/managed-java-runtime');

test('可以解析新旧 Java 版本输出', () => {
  assert.equal(javaMajorFromVersionOutput('java version "1.8.0_441"'), 8);
  assert.equal(javaMajorFromVersionOutput('openjdk version "21.0.7" 2025-04-15'), 21);
  assert.equal(javaMajorFromVersionOutput('openjdk version "25" 2025-09-16'), 25);
});

test('启动器只选择游戏要求的 Java 主版本', async () => {
  const executableName = process.platform === 'win32' ? 'java.exe' : 'java';
  const versions = new Map([
    ['C:/Java/jdk-21/bin/java.exe', 21],
    [executableName, 25]
  ]);
  const probe = async (candidate) => versions.get(candidate);
  const discover = async (explicitPath) => [explicitPath, executableName];
  const executable = await findJavaExecutable(
    'C:/Java/jdk-21/bin/java.exe',
    25,
    probe,
    discover
  );
  assert.equal(executable, executableName);
  await assert.rejects(
    findJavaExecutable('C:/Java/jdk-21/bin/java.exe', 17, probe, discover),
    /需要 Java 17.*检测到 Java 21、25/
  );
});

test('discoverJavaCandidates 按优先级扫描各来源', async () => {
  const fixtureRoot = path.resolve('java-discovery-fixture');
  const systemDirectory = path.join(fixtureRoot, 'Windows', 'system32');
  const toolsDirectory = path.join(fixtureRoot, 'Tools', 'bin');
  const registryHome = path.join(fixtureRoot, 'Registry', 'jdk-11');
  const env = {
    JAVA_HOME: path.join(fixtureRoot, 'Dev', 'jdk-25'),
    JRE_HOME: path.join(fixtureRoot, 'Dev', 'jre-8'),
    PATH: [systemDirectory, toolsDirectory].join(path.delimiter),
    ProgramFiles: path.join(fixtureRoot, 'Program Files'),
    'ProgramFiles(x86)': path.join(fixtureRoot, 'Program Files (x86)'),
    LOCALAPPDATA: path.join(fixtureRoot, 'Users', 'dev', 'AppData', 'Local'),
    USERPROFILE: path.join(fixtureRoot, 'Users', 'dev')
  };
  const javaDirectory = path.join(env.ProgramFiles, 'Java');
  const launcherDirectory = path.join(fixtureRoot, 'Launcher');
  const directories = new Map([
    [javaDirectory, ['jdk-17', 'jdk-21', 'notes.txt']]
  ]);
  const existing = new Set([
    path.join(env.JAVA_HOME, 'bin', 'java.exe'),
    path.join(env.JRE_HOME, 'bin', 'java.exe'),
    path.join(launcherDirectory, '.jre', 'bin', 'java.exe'),
    path.join(toolsDirectory, 'java.exe'),
    path.join(javaDirectory, 'jdk-17', 'bin', 'java.exe'),
    path.join(javaDirectory, 'jdk-21', 'jre', 'bin', 'java.exe'),
    path.join(registryHome, 'bin', 'java.exe')
  ]);
  const fileSystem = {
    readdir: async (dir) => (directories.get(dir) ?? []).map((name) => ({
      name,
      isDirectory: () => !name.endsWith('.txt')
    })),
    access: async (candidate) => {
      if (!existing.has(candidate)) throw new Error('ENOENT');
    }
  };
  const registryQuery = async () => [registryHome];
  const explicit = path.join(fixtureRoot, 'Explicit', 'java.exe');

  const candidates = await discoverJavaCandidates(explicit, {
    platform: 'win32',
    env,
    fileSystem,
    registryQuery,
    launcherDirectory
  });

  assert.equal(candidates[0], explicit);
  assert.equal(candidates[1], path.join(env.JAVA_HOME, 'bin', 'java.exe'));
  assert.equal(candidates[2], path.join(env.JRE_HOME, 'bin', 'java.exe'));
  assert.equal(candidates[3], path.join(launcherDirectory, '.jre', 'bin', 'java.exe'));
  assert.ok(candidates.includes(path.join(toolsDirectory, 'java.exe')));
  assert.ok(candidates.includes(path.join(javaDirectory, 'jdk-17', 'bin', 'java.exe')));
  assert.ok(candidates.includes(path.join(javaDirectory, 'jdk-21', 'jre', 'bin', 'java.exe')));
  assert.ok(candidates.includes(path.join(registryHome, 'bin', 'java.exe')));
  assert.equal(candidates.at(-1), 'java.exe');
  assert.ok(!candidates.includes(path.join(systemDirectory, 'java.exe')));
});

test('detectJava 探测所有候选并返回版本最高的', async () => {
  const versions = new Map([
    [path.join('C:', 'old', 'java.exe'), 8],
    [path.join('C:', 'new', 'java.exe'), 21],
    [path.join('C:', 'mid', 'java.exe'), 17]
  ]);
  const discover = async () => [...versions.keys()];
  const probe = async (candidate) => versions.get(candidate);
  const result = await detectJava(undefined, probe, discover);
  assert.equal(result.available, true);
  assert.equal(result.majorVersion, 21);
  assert.equal(result.path, path.join('C:', 'new', 'java.exe'));
});

test('可以从 Adoptium 元数据选择当前平台的 Java 25 JRE', () => {
  const selected = selectRuntimePackage([{
    release_name: 'jdk-25.0.1+8',
    version: { major: 25 },
    binary: {
      os: adoptiumPlatform(),
      architecture: adoptiumArchitecture(),
      image_type: 'jre',
      package: {
        checksum: 'a'.repeat(64),
        link: 'https://example.com/OpenJDK25U-jre.zip',
        name: `OpenJDK25U-jre${process.platform === 'win32' ? '.zip' : '.tar.gz'}`,
        size: 1234
      }
    }
  }], 25);
  assert.equal(selected.releaseName, 'jdk-25.0.1+8');
  assert.equal(selected.size, 1234);
  assert.equal(selected.checksum, 'a'.repeat(64));
});

const archiveContents = Buffer.from('test archive');
const archiveChecksum = crypto.createHash('sha256').update(archiveContents).digest('hex');

function zuluPackage(majorVersion = 25) {
  const platform = { win32: 'win', darwin: 'macosx', linux: 'linux' }[process.platform];
  const architecture = process.arch === 'x64' ? 'x64' : 'aarch64';
  const name = `zulu-test-ca-jre${majorVersion}.0.1-${platform}_${architecture}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`;
  return {
    package_uuid: '55b71f6b-cb92-4a1f-8d96-dcb5bc680881',
    name,
    java_version: [majorVersion, 0, 1],
    java_package_type: 'jre',
    javafx_bundled: false,
    os: process.platform === 'darwin' ? 'macos' : adoptiumPlatform(),
    arch: process.arch === 'x64' ? 'x86' : 'aarch64',
    hw_bitness: 64,
    download_url: `https://cdn.azul.com/zulu/bin/${name}`,
    size: archiveContents.length,
    sha256_hash: archiveChecksum
  };
}

function adoptiumPackage(majorVersion) {
  const name = `java-${majorVersion}${process.platform === 'win32' ? '.zip' : '.tar.gz'}`;
  return {
    release_name: `jdk-${majorVersion}-test`,
    version: { major: majorVersion },
    binary: {
      os: adoptiumPlatform(),
      architecture: adoptiumArchitecture(),
      image_type: 'jre',
      package: {
        link: `https://example.com/${name}`,
        name,
        size: archiveContents.length,
        checksum: archiveChecksum
      }
    }
  };
}

async function runtimeFixture(t, majorVersion = 25, overrides = {}) {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-java-runtime-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  const metadataRequests = [];
  const downloads = [];
  const executableName = process.platform === 'win32' ? 'java.exe' : 'java';
  const manager = new ManagedJavaRuntime({
    gameDirectory,
    findSystemJava: async () => { throw new Error('missing'); },
    probeJava: async (executable) => {
      await fs.access(executable);
      return majorVersion;
    },
    fetchRuntimeAssets: async (url) => {
      metadataRequests.push(url);
      if (url.startsWith(AZUL_API)) {
        return url.includes('?') ? [zuluPackage(majorVersion)] : zuluPackage(majorVersion);
      }
      return [adoptiumPackage(majorVersion)];
    },
    download: async (url, destination, options) => {
      downloads.push({ url, options });
      await fs.writeFile(destination, archiveContents);
    },
    extractArchive: async (_archive, destination) => {
      const bin = path.join(destination, `jre-${majorVersion}`, 'bin');
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(bin, executableName), 'test java');
    },
    ...overrides
  });
  return { manager, gameDirectory, metadataRequests, downloads, executableName };
}

test('缺少指定 Java 时只提示从设置下载，不会自动请求网络', async (t) => {
  const { manager, metadataRequests, downloads } = await runtimeFixture(t);
  await assert.rejects(manager.resolve(undefined, 25), /需要 Java 25.*设置.*下载/);
  assert.equal(metadataRequests.length, 0);
  assert.equal(downloads.length, 0);
});

test('已有系统 Java 时启动直接使用系统环境', async (t) => {
  const { manager, metadataRequests } = await runtimeFixture(t, 21, {
    findSystemJava: async (explicitPath, majorVersion) => {
      assert.equal(explicitPath, 'system-java');
      assert.equal(majorVersion, 21);
      return 'system-java';
    }
  });
  assert.equal(await manager.resolve('system-java', 21), 'system-java');
  assert.equal(metadataRequests.length, 0);
});

test('手动下载指定版本的 Azul JRE 后会复用缓存并可启动', async (t) => {
  const { manager, metadataRequests, downloads, executableName } = await runtimeFixture(t, 21, {
    segmentConcurrency: 6
  });
  const [first, concurrent] = await Promise.all([
    manager.ensureInstalled(21), manager.ensureInstalled(21)
  ]);
  const second = await manager.ensureInstalled(21);
  assert.equal(first, second);
  assert.equal(first, concurrent);
  assert.equal(await manager.resolve(undefined, 21), first);
  assert.equal(path.basename(first), executableName);
  assert.equal(metadataRequests.length, 2);
  const query = new URL(metadataRequests[0]).searchParams;
  assert.equal(query.get('java_version'), '21');
  assert.equal(query.get('java_package_type'), 'jre');
  assert.equal(query.get('javafx_bundled'), 'false');
  assert.equal(downloads.length, 1);
  assert.equal(new URL(downloads[0].url).hostname, 'cdn.azul.com');
  assert.equal(downloads[0].options.segmentConcurrency, 6);
  assert.equal(downloads[0].options.size, archiveContents.length);
  await assert.rejects(manager.resolve(undefined, 25), /需要 Java 25/);
});

test('运行环境下载只接受支持的 Java 主版本', async (t) => {
  const { manager, metadataRequests } = await runtimeFixture(t);
  for (const value of [0, 11, 26, '25', undefined]) {
    await assert.rejects(manager.ensureInstalled(value), /Java 8、16、17、21 或 25/);
  }
  assert.equal(metadataRequests.length, 0);
});

test('Minecraft 1.17 所需的 Java 16 可以显式安装并复用', async (t) => {
  const { manager, downloads } = await runtimeFixture(t, 16);
  const executable = await manager.ensureInstalled(16);
  assert.equal(await manager.resolve(undefined, 16), executable);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].url, /jre16/);
});

test('默认 Java 下载使用 CDN 实际大小修正元数据后分段下载并保留校验', async (t) => {
  const contents = Buffer.alloc(5 * 1024 * 1024, 1);
  const entry = {
    ...zuluPackage(),
    size: contents.length + 35,
    sha256_hash: crypto.createHash('sha256').update(contents).digest('hex')
  };
  const ranges = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    assert.equal(url, entry.download_url);
    const range = new Headers(options.headers).get('range');
    assert.ok(range);
    ranges.push(range);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
    return new Response(contents.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${end}/${contents.length}` }
    });
  });
  const { manager } = await runtimeFixture(t, 25, {
    download: undefined,
    segmentConcurrency: 3,
    fetchRuntimeAssets: async (url) => url.includes('?') ? [entry] : entry
  });
  const progress = [];
  assert.ok(await manager.ensureInstalled(25, (value) => progress.push(value)));
  assert.equal(ranges.length, 5);
  assert.equal(ranges[0], 'bytes=0-0');
  assert.equal(ranges[1], 'bytes=0-0');
  assert.ok(progress.some((value) => value.totalBytes === contents.length
    && value.receivedBytes === contents.length));
});

test('CDN 大小探测超时时继续用官方元数据下载', async (t) => {
  let requests = 0;
  t.mock.method(global, 'fetch', async (_url, options) => {
    requests += 1;
    if (requests === 1) {
      assert.equal(new Headers(options.headers).get('range'), 'bytes=0-0');
      assert.ok(options.signal);
      const error = new Error('timeout');
      error.name = 'TimeoutError';
      throw error;
    }
    assert.equal(new Headers(options.headers).get('range'), null);
    return new Response(archiveContents);
  });
  const { manager } = await runtimeFixture(t, 25, { download: undefined });
  assert.ok(await manager.ensureInstalled(25));
  assert.equal(requests, 2);
});

test('CDN 大小探测时取消不会发起归档下载或切换备用源', async (t) => {
  const controller = new AbortController();
  let requests = 0;
  t.mock.method(global, 'fetch', async () => {
    requests += 1;
    controller.abort();
    throw new Error('cancelled');
  });
  const { manager, metadataRequests } = await runtimeFixture(t, 25, { download: undefined });
  await assert.rejects(manager.ensureInstalled(25, undefined, controller.signal), { name: 'AbortError' });
  assert.equal(requests, 1);
  assert.equal(metadataRequests.length, 2);
});

test('Azul 包必须符合主版本、JRE 类型、平台和官方 CDN', () => {
  const entry = zuluPackage();
  assert.equal(selectZuluRuntimePackage([entry], 25).checksum, archiveChecksum);
  assert.throws(() => selectZuluRuntimePackage([entry], 21), /未找到/);
  for (const change of [
    { java_package_type: 'jdk' },
    { os: 'invalid' },
    { arch: 'invalid' },
    { javafx_bundled: true },
    { name: entry.name.replace('-jre', '-jdk') }
  ]) assert.throws(() => selectZuluRuntimePackage([{ ...entry, ...change }], 25), /未找到/);
  assert.throws(() => selectZuluRuntimePackage([{ ...entry, download_url: 'https://example.com/java.zip' }], 25), /不安全/);
  assert.throws(() => selectZuluRuntimePackage([{ ...entry, sha256_hash: '' }], 25), /校验信息不完整/);
});

test('Azul 元数据不可用时改用 Adoptium 指定版本的 JRE', async (t) => {
  const requested = [];
  const { manager, downloads } = await runtimeFixture(t, 17, {
    fetchRuntimeAssets: async (url) => {
      requested.push(url);
      if (url.startsWith(AZUL_API)) throw new Error('Azul unavailable');
      return [adoptiumPackage(17)];
    }
  });
  await manager.ensureInstalled(17);
  assert.equal(requested.length, 2);
  assert.match(requested[1], /assets\/latest\/17\/hotspot/);
  assert.equal(new URL(requested[1]).searchParams.get('image_type'), 'jre');
  assert.equal(downloads.length, 1);
  assert.equal(new URL(downloads[0].url).hostname, 'example.com');
});

test('Azul CDN 失败时改用 Adoptium 且校验归档', async (t) => {
  const downloaded = [];
  const { manager, metadataRequests } = await runtimeFixture(t, 8, {
    download: async (url, destination) => {
      downloaded.push(url);
      if (url.includes('cdn.azul.com')) throw new Error('CDN unavailable');
      await fs.writeFile(destination, archiveContents);
    }
  });
  await manager.ensureInstalled(8);
  assert.equal(downloaded.length, 2);
  assert.equal(metadataRequests.length, 3);
  assert.match(downloaded[1], /java-8/);
});

test('归档 SHA-256 错误时不会提交运行环境', async (t) => {
  let extractionCount = 0;
  const { manager } = await runtimeFixture(t, 25, {
    download: async (_url, destination) => fs.writeFile(destination, Buffer.alloc(archiveContents.length)),
    extractArchive: async () => { extractionCount += 1; }
  });
  await assert.rejects(manager.ensureInstalled(25), /SHA-256/);
  assert.equal(extractionCount, 0);
  assert.equal(await manager.installedExecutable(25), undefined);
});

test('下载后的 Java 主版本不符时不会提交运行环境', async (t) => {
  const { manager } = await runtimeFixture(t, 25, { probeJava: async () => 21 });
  await assert.rejects(manager.ensureInstalled(25), /不是有效的 Java 25/);
  assert.equal(await manager.installedExecutable(25), undefined);
});

test('获取元数据时取消不会切换备用源，且允许重新下载', async (t) => {
  const controller = new AbortController();
  let requests = 0;
  const { manager } = await runtimeFixture(t, 25, {
    fetchRuntimeAssets: async () => {
      requests += 1;
      controller.abort();
      throw new Error('cancelled');
    }
  });
  await assert.rejects(manager.ensureInstalled(25, undefined, controller.signal), { name: 'AbortError' });
  assert.equal(requests, 1);
  assert.equal(manager.installing.size, 0);
  manager.fetchRuntimeAssets = async (url) => url.includes('?') ? [zuluPackage()] : zuluPackage();
  assert.ok(await manager.ensureInstalled(25));
});

test('下载取消时会传递信号、清理归档且不会安装', async (t) => {
  const controller = new AbortController();
  let extractionCount = 0;
  const { manager, gameDirectory, metadataRequests } = await runtimeFixture(t, 25, {
    download: async (_url, destination, options) => {
      assert.equal(options.signal, controller.signal);
      await fs.writeFile(destination, archiveContents);
      controller.abort();
    },
    extractArchive: async () => { extractionCount += 1; }
  });
  await assert.rejects(manager.ensureInstalled(25, undefined, controller.signal), { name: 'AbortError' });
  assert.equal(metadataRequests.length, 2);
  assert.equal(extractionCount, 0);
  assert.deepEqual(await fs.readdir(path.join(gameDirectory, 'runtime', 'melody')), []);
});

test('解压时取消会阻止探测和提交安装目录', async (t) => {
  const controller = new AbortController();
  let probes = 0;
  const { manager, gameDirectory } = await runtimeFixture(t, 25, {
    probeJava: async () => { probes += 1; return 25; },
    extractArchive: async (_archive, destination) => {
      await fs.writeFile(path.join(destination, 'partial'), 'partial');
      controller.abort();
    }
  });
  await assert.rejects(manager.ensureInstalled(25, undefined, controller.signal), { name: 'AbortError' });
  assert.equal(probes, 0);
  assert.deepEqual(await fs.readdir(path.join(gameDirectory, 'runtime', 'melody')), []);
});

test('Java 探测时取消会阻止提交安装目录', async (t) => {
  const controller = new AbortController();
  const { manager, gameDirectory } = await runtimeFixture(t, 25, {
    probeJava: async () => {
      controller.abort();
      return 25;
    }
  });
  await assert.rejects(manager.ensureInstalled(25, undefined, controller.signal), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(path.join(gameDirectory, 'runtime', 'melody')), []);
});
