const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Windows 注册表中的 Java 安装位置（参考 PCL/HMCL 的 JavaSoft 查找）
const WINDOWS_REGISTRY_KEYS = Object.freeze([
  'HKLM\\SOFTWARE\\JavaSoft\\JDK',
  'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
  'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
  'HKLM\\SOFTWARE\\Wow6432Node\\JavaSoft\\JDK',
  'HKLM\\SOFTWARE\\Wow6432Node\\JavaSoft\\Java Development Kit',
  'HKLM\\SOFTWARE\\Wow6432Node\\JavaSoft\\Java Runtime Environment',
  'HKCU\\SOFTWARE\\JavaSoft\\JDK',
  'HKCU\\SOFTWARE\\JavaSoft\\Java Development Kit',
  'HKCU\\SOFTWARE\\JavaSoft\\Java Runtime Environment'
]);

const REGISTRY_TIMEOUT_MS = 5000;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function javaExecutableName(platform = process.platform) {
  return platform === 'win32' ? 'java.exe' : 'java';
}

function windowsJavaDirectories(env) {
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = env.LOCALAPPDATA;
  const userHome = env.USERPROFILE || os.homedir();
  return unique([
    path.join(programFiles, 'Java'),
    path.join(programFilesX86, 'Java'),
    path.join(programFiles, 'Eclipse Adoptium'),
    path.join(programFilesX86, 'Eclipse Adoptium'),
    path.join(programFiles, 'Microsoft'),
    path.join(programFiles, 'Zulu'),
    path.join(programFiles, 'Amazon Corretto'),
    path.join(programFiles, 'BellSoft'),
    path.join(programFiles, 'Semeru'),
    path.join(programFiles, 'Common Files', 'Oracle', 'Java'),
    path.join(programFilesX86, 'Common Files', 'Oracle', 'Java'),
    localAppData ? path.join(localAppData, 'Programs', 'Eclipse Adoptium') : null,
    path.join(userHome, '.jdks')
  ]);
}

function unixJavaDirectories(env) {
  const userHome = env.HOME || os.homedir();
  return unique([
    '/usr/lib/jvm',
    '/usr/java',
    '/opt/java',
    path.join(userHome, '.sdkman', 'candidates', 'java'),
    path.join(userHome, '.jdks')
  ]);
}

function macOSJavaDirectories(env) {
  const userHome = env.HOME || os.homedir();
  return unique([
    '/Library/Java/JavaVirtualMachines',
    path.join(userHome, 'Library', 'Java', 'JavaVirtualMachines'),
    '/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home'
  ]);
}

// 扫描某个基础目录下的所有 Java 主目录，兼容 bin 与旧版 jre/bin 布局，macOS 为 Contents/Home
async function scanJavaBaseDirectory(baseDir, executable, platform, fileSystem) {
  let entries;
  try {
    entries = await fileSystem.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(baseDir, entry.name);
    const layouts = platform === 'darwin'
      ? [path.join(entryPath, 'Contents', 'Home', 'bin')]
      : [path.join(entryPath, 'bin'), path.join(entryPath, 'jre', 'bin')];
    for (const layout of layouts) {
      found.push(path.join(layout, executable));
    }
  }
  return found;
}

function expandRegistryValue(value, env) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => env[name] ?? whole);
}

function queryRegistryKey(key, env) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish([]);
    }, REGISTRY_TIMEOUT_MS);
    const child = spawn('reg', ['query', key, '/s', '/v', 'JavaHome'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.once('error', () => finish([]));
    child.once('close', () => {
      const homes = [];
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/JavaHome\s+REG_(?:EXPAND_)?SZ\s+(.+)$/i);
        if (match) homes.push(expandRegistryValue(match[1].trim(), env));
      }
      finish(homes);
    });
  });
}

async function queryRegistryJavaHomes(env) {
  const lists = await Promise.all(
    WINDOWS_REGISTRY_KEYS.map((key) => queryRegistryKey(key, env))
  );
  return lists.flat();
}

// 参考 PCL/HMCL：显式路径 → JAVA_HOME/JRE_HOME → 启动器旁 .jre 便携目录 →
// PATH 目录 → 常见安装目录 → Windows 注册表 → 裸 java 兜底
async function discoverJavaCandidates(explicitPath, {
  platform = process.platform,
  env = process.env,
  fileSystem = fs,
  registryQuery = queryRegistryJavaHomes,
  launcherDirectory = path.dirname(process.execPath)
} = {}) {
  const executable = javaExecutableName(platform);
  const candidates = [explicitPath];

  if (env.JAVA_HOME) candidates.push(path.join(env.JAVA_HOME, 'bin', executable));
  if (env.JRE_HOME) candidates.push(path.join(env.JRE_HOME, 'bin', executable));

  // PCL 便携 Java：启动器同目录下的 .jre
  candidates.push(path.join(launcherDirectory, '.jre', 'bin', executable));

  if (env.PATH) {
    for (const dir of env.PATH.split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, executable));
    }
  }

  const baseDirectories = platform === 'win32'
    ? windowsJavaDirectories(env)
    : platform === 'darwin'
      ? [...unixJavaDirectories(env), ...macOSJavaDirectories(env)]
      : unixJavaDirectories(env);
  for (const baseDirectory of baseDirectories) {
    candidates.push(...await scanJavaBaseDirectory(baseDirectory, executable, platform, fileSystem));
  }

  if (platform === 'win32') {
    for (const home of await registryQuery(env)) {
      candidates.push(path.join(home, 'bin', executable));
    }
  }

  // 裸命令交给 spawn 按 PATH 解析（兜底）
  candidates.push(executable);

  const existing = [];
  for (const candidate of unique(candidates)) {
    if (!candidate) continue;
    // 显式路径与裸命令保持原样（不存在时由探测阶段处理）
    if (!path.isAbsolute(candidate) || candidate === explicitPath) {
      existing.push(candidate);
      continue;
    }
    try {
      await fileSystem.access(candidate);
      existing.push(candidate);
    } catch {}
  }
  return existing;
}

function javaMajorFromVersionOutput(output) {
  const match = String(output ?? '').match(/(?:java|openjdk) version "(?:1\.)?(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

async function javaMajorVersion(executable, timeoutMs = 8000) {
  if (path.isAbsolute(executable)) {
    try {
      await fs.access(executable);
    } catch {
      return undefined;
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(executable, ['-version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const collect = (chunk) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-8000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = (majorVersion) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(majorVersion);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, timeoutMs);

    child.once('error', () => finish(undefined));
    child.once('close', (code) => finish(code === 0 ? javaMajorFromVersionOutput(output) : undefined));
  });
}

async function findJavaExecutable(
  explicitPath,
  requiredMajorVersion,
  probe = javaMajorVersion,
  discover = discoverJavaCandidates
) {
  const detectedVersions = [];
  for (const candidate of await discover(explicitPath)) {
    const majorVersion = await probe(candidate);
    if (!Number.isInteger(majorVersion)) continue;
    detectedVersions.push(majorVersion);
    if (!Number.isInteger(requiredMajorVersion) || majorVersion === requiredMajorVersion) {
      return candidate;
    }
  }

  if (Number.isInteger(requiredMajorVersion)) {
    const detectedHint = detectedVersions.length > 0
      ? `；当前检测到 Java ${[...new Set(detectedVersions)].join('、')}`
      : '';
    throw new Error(`该游戏版本需要 Java ${requiredMajorVersion}${detectedHint}`);
  }
  throw new Error('未找到可用的 Java。请先安装 Java，或在 JAVA_HOME 中配置 Java 路径');
}

// 设置页自动检测：探测所有候选并返回版本最高的（参考 PCL 自动选择最新 Java）
async function detectJava(explicitPath, probe = javaMajorVersion, discover = discoverJavaCandidates) {
  const candidates = await discover(explicitPath);
  const results = await Promise.all(candidates.map(async (candidate) => ({
    path: candidate,
    majorVersion: await probe(candidate)
  })));
  const available = results.filter((result) => Number.isInteger(result.majorVersion));
  if (available.length === 0) {
    return { available: false, majorVersion: undefined, path: undefined };
  }
  available.sort((left, right) => right.majorVersion - left.majorVersion);
  return { available: true, majorVersion: available[0].majorVersion, path: available[0].path };
}

function buildInstallerArguments(installerPath, gameDirectory) {
  return ['-jar', installerPath, '--installClient', gameDirectory];
}

async function runJavaInstaller({
  javaExecutable,
  installerPath,
  gameDirectory,
  signal,
  onOutput = () => {}
}) {
  if (signal?.aborted) {
    const error = new Error('下载已取消');
    error.name = 'AbortError';
    throw error;
  }
  const argumentsList = buildInstallerArguments(installerPath, gameDirectory);

  await new Promise((resolve, reject) => {
    const child = spawn(javaExecutable, argumentsList, {
      cwd: gameDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      callback();
    };

    const abort = () => {
      child.kill();
      const error = new Error('下载已取消');
      error.name = 'AbortError';
      finish(() => reject(error));
    };
    signal?.addEventListener('abort', abort, { once: true });

    const collect = (chunk) => {
      const text = chunk.toString('utf8');
      output = `${output}${text}`.slice(-16000);
      const latestLine = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      if (latestLine) onOutput(latestLine);
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      finish(() => reject(new Error(`无法启动 Java 安装器：${error.message}`)));
    });
    child.once('close', (code) => {
      if (code === 0) {
        finish(resolve);
        return;
      }
      const detail = output.trim().split(/\r?\n/).slice(-5).join(' ');
      finish(() => reject(
        new Error(`加载器安装器执行失败（退出码 ${code}）${detail ? `：${detail}` : ''}`)
      ));
    });
  });
}

module.exports = {
  buildInstallerArguments,
  detectJava,
  discoverJavaCandidates,
  findJavaExecutable,
  javaMajorFromVersionOutput,
  javaMajorVersion,
  javaExecutableName,
  runJavaInstaller
};
