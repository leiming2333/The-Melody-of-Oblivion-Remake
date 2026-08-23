const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function javaCandidates(explicitPath) {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  return unique([
    explicitPath,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', executable) : undefined,
    executable
  ]);
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

async function findJavaExecutable(explicitPath, requiredMajorVersion, probe = javaMajorVersion) {
  const detectedVersions = [];
  for (const candidate of javaCandidates(explicitPath)) {
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

async function detectJava(explicitPath, probe = javaMajorVersion) {
  for (const candidate of javaCandidates(explicitPath)) {
    const majorVersion = await probe(candidate);
    if (Number.isInteger(majorVersion)) {
      return { available: true, majorVersion, path: candidate };
    }
  }
  return { available: false, majorVersion: undefined, path: undefined };
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
  findJavaExecutable,
  javaMajorFromVersionOutput,
  javaMajorVersion,
  javaCandidates,
  runJavaInstaller
};
