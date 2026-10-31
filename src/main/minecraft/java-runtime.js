const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const SUPPORTED_JAVA_MAJORS = Object.freeze([8, 16, 17, 21, 25]);

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
  // 文件系统扫描与注册表查询同时执行，保留原有候选优先级。
  const [directoryCandidates, registryHomes] = await Promise.all([
    Promise.all(baseDirectories.map((baseDirectory) =>
      scanJavaBaseDirectory(baseDirectory, executable, platform, fileSystem))),
    platform === 'win32' ? registryQuery(env) : []
  ]);
  candidates.push(...directoryCandidates.flat());
  for (const home of registryHomes) {
    candidates.push(path.join(home, 'bin', executable));
  }

  // 裸命令交给 spawn 按 PATH 解析（兜底）
  candidates.push(executable);

  const existing = await Promise.all(unique(candidates).map(async (candidate) => {
    // 显式路径与裸命令保持原样（不存在时由探测阶段处理）
    if (!path.isAbsolute(candidate) || candidate === explicitPath) {
      return candidate;
    }
    try {
      await fileSystem.access(candidate);
      return candidate;
    } catch {}
    return null;
  }));
  return existing.filter(Boolean);
}

function javaMajorFromVersionOutput(output) {
  const match = String(output ?? '').match(/(?:java|openjdk) version "(?:1\.)?(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

function javaDetailsFromVersionOutput(output) {
  const majorVersion = javaMajorFromVersionOutput(output);
  if (!majorVersion) return undefined;
  const rawArch = String(output).match(/^\s*os\.arch\s*=\s*(\S+)/m)?.[1]?.toLowerCase();
  const architecture = /^(?:amd64|x86_64|x64)$/.test(rawArch ?? '') ? 'x64'
    : /^(?:x86|i[3-6]86|ia32)$/.test(rawArch ?? '') ? 'ia32'
      : /^(?:aarch64|arm64)$/.test(rawArch ?? '') ? 'arm64'
        : /^arm/.test(rawArch ?? '') ? 'arm' : undefined;
  const declaredBits = Number(String(output).match(/^\s*sun\.arch\.data\.model\s*=\s*(32|64)/m)?.[1]);
  const bits = declaredBits || (architecture ? (['x64', 'arm64'].includes(architecture) ? 64 : 32)
    : /64-Bit/i.test(output) ? 64 : undefined);
  const property = (name) => String(output).match(new RegExp(`^\\s*${name.replaceAll('.', '\\.')}\\s*=\\s*(\\S+)`, 'm'))?.[1];
  return { majorVersion, architecture, bits,
    nativeEncoding: property('native.encoding') ?? property('sun.jnu.encoding') ?? property('file.encoding'),
    fileEncoding: property('file.encoding') };
}

async function javaRuntimeDetails(executable, timeoutMs = 8000) {
  if (path.isAbsolute(executable)) {
    try {
      await fs.access(executable);
    } catch {
      return undefined;
    }
  }

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(executable, ['-XshowSettings:properties', '-version'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    const collect = (chunk) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-8000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = (details) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(details);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, timeoutMs);

    child.once('error', () => finish(undefined));
    child.once('close', (code) => finish(code === 0 ? javaDetailsFromVersionOutput(output) : undefined));
  });
}

async function javaMajorVersion(executable, timeoutMs = 8000) {
  return (await javaRuntimeDetails(executable, timeoutMs))?.majorVersion;
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
async function detectJava(explicitPath, probe = javaMajorVersion, discover = discoverJavaCandidates, options) {
  const candidates = await discover(explicitPath, options);
  const results = await Promise.allSettled(candidates.map(async (candidate) => ({
    path: candidate,
    majorVersion: await probe(candidate)
  })));
  const available = results.filter((result) => result.status === 'fulfilled')
    .map((result) => result.value).filter((result) => Number.isInteger(result.majorVersion));
  if (available.length === 0) {
    return { available: false, majorVersion: undefined, path: undefined };
  }
  available.sort((left, right) => right.majorVersion - left.majorVersion);
  return { available: true, majorVersion: available[0].majorVersion, path: available[0].path, runtimes: available };
}

function buildInstallerArguments(installerPath, gameDirectory) {
  return ['-jar', installerPath, '--installClient', gameDirectory];
}

async function installedJavaExecutable(gameDirectory, majorVersion, probe = javaMajorVersion,
  { architecture = process.arch } = {}) {
  for (const name of [`java-${majorVersion}-${architecture}`, `java-${majorVersion}`]) {
    try {
      const root = path.join(gameDirectory, 'runtime', 'melody', name);
      const marker = JSON.parse(await fs.readFile(path.join(root, '.melody-runtime.json'), 'utf8'));
      if (marker.schemaVersion !== 1 || marker.majorVersion !== majorVersion
          || typeof marker.executable !== 'string') continue;
      const executable = path.resolve(root, marker.executable);
      if (!executable.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
      if (marker.architecture && marker.architecture !== architecture) continue;
      if (probe === javaMajorVersion) {
        const details = await javaRuntimeDetails(executable);
        if (details?.architecture !== architecture) continue;
        if (details.majorVersion === majorVersion) return executable;
      } else if (await probe(executable) === majorVersion) return executable;
    } catch { /* Try a legacy installation after an unavailable current one. */ }
  }
  return undefined;
}

async function runJavaInstaller({
  javaExecutable,
  installerPath,
  gameDirectory,
  signal,
  onOutput = () => {},
  onLog = () => {},
  idleTimeoutMs = 10 * 60 * 1000,
  spawnProcess = spawn
}) {
  if (signal?.aborted) {
    const error = new Error('下载已取消');
    error.name = 'AbortError';
    throw error;
  }
  const argumentsList = buildInstallerArguments(installerPath, gameDirectory);

  await new Promise((resolve, reject) => {
    const child = spawnProcess(javaExecutable, argumentsList, {
      cwd: gameDirectory,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    let stopping = false;
    let failure;
    let idleTimer;
    let killTimer;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      callback();
    };

    const stop = (error) => {
      failure ??= error;
      if (settled || stopping) return;
      stopping = true;
      clearTimeout(idleTimer);
      // A failed kill can throw or emit another child error. Preserve the
      // original failure and retain ownership until the close event arrives.
      try { child.kill(); } catch { /* Escalate below and continue draining. */ }
      if (!settled) {
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* Continue waiting for close. */ }
        }, 2000);
        killTimer.unref?.();
      }
    };
    const abort = () => {
      const error = Object.assign(new Error('下载已取消'), { name: 'AbortError' });
      stop(error);
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      if (settled || failure) return;
      if (idleTimeoutMs > 0) idleTimer = setTimeout(() => stop(Object.assign(
        new Error('加载器安装长时间没有输出，请检查网络后重试'),
        { code: 'INSTALLER_IDLE_TIMEOUT', phase: 'installing-loader', retryable: true }
      )), idleTimeoutMs);
      idleTimer?.unref?.();
    };
    const collect = (channel, chunk) => {
      if (settled) return;
      resetIdleTimer();
      try {
        onLog(channel, chunk);
        const text = chunk.toString('utf8');
        output = `${output}${text}`.slice(-16000);
        const latestLine = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
        if (latestLine && !failure) onOutput(latestLine);
      } catch (cause) {
        stop(Object.assign(new Error(`处理加载器安装器输出失败：${cause.message}`, { cause }),
          { code: cause.code ?? 'INSTALLER_OUTPUT_FAILED', phase: 'installing-loader', retryable: true }));
      }
    };

    for (const channel of ['stdout', 'stderr']) {
      child[channel]?.on('data', (chunk) => collect(channel, chunk));
      child[channel]?.on('error', (cause) => {
        if (!settled) stop(Object.assign(new Error(`读取加载器安装器 ${channel} 输出失败：${cause.message}`, { cause }),
          { code: cause.code ?? 'INSTALLER_OUTPUT_FAILED', phase: 'installing-loader', retryable: true }));
      });
    }
    child.on('error', (error) => {
      if (settled) return;
      if (child.pid) {
        stop(Object.assign(new Error(`Java 安装器进程错误：${error.message}`, { cause: error }),
          { code: error.code ?? 'INSTALLER_FAILED', phase: 'installing-loader', retryable: true }));
        return;
      }
      finish(() => reject(new Error(`无法启动 Java 安装器：${error.message}`, { cause: error })));
    });
    child.once('close', (code) => {
      if (failure) { finish(() => reject(failure)); return; }
      if (code === 0) {
        finish(resolve);
        return;
      }
      const detail = output.trim().split(/\r?\n/).slice(-5).join(' ');
      finish(() => reject(
        Object.assign(new Error(`加载器安装器执行失败（退出码 ${code}）${detail ? `：${detail}` : ''}`),
          { code: 'INSTALLER_FAILED', exitCode: code, phase: 'installing-loader', retryable: true })
      ));
    });
    // Attach process/stream listeners before an already-delivered cancellation
    // can kill a process whose close event may arrive immediately.
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else resetIdleTimer();
  });
}

module.exports = {
  SUPPORTED_JAVA_MAJORS,
  installedJavaExecutable,
  buildInstallerArguments,
  detectJava,
  discoverJavaCandidates,
  findJavaExecutable,
  javaMajorFromVersionOutput,
  javaMajorVersion,
  javaDetailsFromVersionOutput,
  javaRuntimeDetails,
  javaExecutableName,
  runJavaInstaller
};
