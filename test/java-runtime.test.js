const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  detectJava,
  discoverJavaCandidates,
  findJavaExecutable,
  javaMajorFromVersionOutput
} = require('../src/main/minecraft/java-runtime');
const {
  ManagedJavaRuntime,
  adoptiumArchitecture,
  adoptiumPlatform,
  selectRuntimePackage
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
  const env = {
    JAVA_HOME: path.join('C:', 'Dev', 'jdk-25'),
    JRE_HOME: path.join('C:', 'Dev', 'jre-8'),
    PATH: [path.join('C:', 'Windows', 'system32'), path.join('C:', 'Tools', 'bin')].join(path.delimiter),
    ProgramFiles: path.join('C:', 'Program Files'),
    'ProgramFiles(x86)': path.join('C:', 'Program Files (x86)'),
    LOCALAPPDATA: path.join('C:', 'Users', 'dev', 'AppData', 'Local'),
    USERPROFILE: path.join('C:', 'Users', 'dev')
  };
  const javaDirectory = path.join(env.ProgramFiles, 'Java');
  const launcherDirectory = path.join('D:', 'Launcher');
  const directories = new Map([
    [javaDirectory, ['jdk-17', 'jdk-21', 'notes.txt']]
  ]);
  const existing = new Set([
    path.join(env.JAVA_HOME, 'bin', 'java.exe'),
    path.join(env.JRE_HOME, 'bin', 'java.exe'),
    path.join(launcherDirectory, '.jre', 'bin', 'java.exe'),
    path.join('C:', 'Tools', 'bin', 'java.exe'),
    path.join(javaDirectory, 'jdk-17', 'bin', 'java.exe'),
    path.join(javaDirectory, 'jdk-21', 'jre', 'bin', 'java.exe'),
    path.join('C:', 'Registry', 'jdk-11', 'bin', 'java.exe')
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
  const registryQuery = async () => [path.join('C:', 'Registry', 'jdk-11')];
  const explicit = path.join('C:', 'Explicit', 'java.exe');

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
  assert.ok(candidates.includes(path.join('C:', 'Tools', 'bin', 'java.exe')));
  assert.ok(candidates.includes(path.join(javaDirectory, 'jdk-17', 'bin', 'java.exe')));
  assert.ok(candidates.includes(path.join(javaDirectory, 'jdk-21', 'jre', 'bin', 'java.exe')));
  assert.ok(candidates.includes(path.join('C:', 'Registry', 'jdk-11', 'bin', 'java.exe')));
  assert.equal(candidates.at(-1), 'java.exe');
  assert.ok(!candidates.includes(path.join('C:', 'Windows', 'system32', 'java.exe')));
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
        name: 'OpenJDK25U-jre.zip',
        size: 1234
      }
    }
  }], 25);
  assert.equal(selected.releaseName, 'jdk-25.0.1+8');
  assert.equal(selected.size, 1234);
  assert.equal(selected.checksum, 'a'.repeat(64));
});

test('缺少 Java 25 时会安装并复用启动器托管运行时', async (t) => {
  if (process.platform !== 'win32') return;
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-java-runtime-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  let metadataRequests = 0;
  const manager = new ManagedJavaRuntime({
    gameDirectory,
    findSystemJava: async () => { throw new Error('missing'); },
    probeJava: async (executable) => path.basename(executable).toLowerCase() === 'java.exe'
      ? 25
      : undefined,
    fetchRuntimeAssets: async () => {
      metadataRequests += 1;
      return [{
        release_name: 'jdk-25-test',
        version: { major: 25 },
        binary: {
          os: adoptiumPlatform(),
          architecture: adoptiumArchitecture(),
          image_type: 'jre',
          package: {
            link: 'https://example.com/java-25.zip',
            name: 'java-25.zip'
          }
        }
      }];
    },
    download: async (_url, destination) => fs.writeFile(destination, 'test archive'),
    extractArchive: async (_archive, destination) => {
      const bin = path.join(destination, 'jdk-25', 'bin');
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(bin, 'java.exe'), 'test java');
    }
  });

  const first = await manager.resolve(undefined, 25);
  const second = await manager.resolve(undefined, 25);
  assert.equal(first, second);
  assert.equal(path.basename(first), 'java.exe');
  assert.equal(metadataRequests, 1);
});
