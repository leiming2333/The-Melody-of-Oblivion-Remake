const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { findJavaExecutable, javaMajorVersion } = require('./java-runtime');

const ADOPTIUM_API = 'https://api.adoptium.net/v3';

function adoptiumPlatform(platform = process.platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  return undefined;
}

function adoptiumArchitecture(architecture = process.arch) {
  if (architecture === 'x64') return 'x64';
  if (architecture === 'arm64') return 'aarch64';
  return undefined;
}

function selectRuntimePackage(assets, requiredMajorVersion, platform = process.platform) {
  const expectedOs = adoptiumPlatform(platform);
  const expectedArchitecture = adoptiumArchitecture();
  const asset = Array.isArray(assets) ? assets.find((entry) => (
    Number(entry?.version?.major) === requiredMajorVersion
    && entry?.binary?.os === expectedOs
    && entry?.binary?.architecture === expectedArchitecture
    && entry?.binary?.image_type === 'jre'
    && entry?.binary?.package?.link
  )) : undefined;
  if (!asset) throw new Error(`未找到适用于当前系统的 Java ${requiredMajorVersion} 运行时`);
  const link = new URL(String(asset.binary.package.link));
  if (link.protocol !== 'https:') throw new Error('Java 运行时下载地址不安全');
  const packageName = path.basename(String(asset.binary.package.name ?? `java-${requiredMajorVersion}.zip`));
  if (platform === 'win32' && path.extname(packageName).toLowerCase() !== '.zip') {
    throw new Error('Java 运行时压缩包格式不受支持');
  }
  return {
    checksum: String(asset.binary.package.checksum ?? '').toLowerCase(),
    link: link.toString(),
    name: packageName,
    releaseName: String(asset.release_name ?? `Java ${requiredMajorVersion}`),
    size: Number(asset.binary.package.size) || undefined
  };
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Melody-of-Oblivion-Launcher/0.1' },
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error(`Java 运行时信息获取失败（HTTP ${response.status}）`);
  return response.json();
}

async function downloadArchive(url, destination, { signal, size, onProgress = () => {} } = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Melody-of-Oblivion-Launcher/0.1' },
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
  });
  if (!response.ok || !response.body) throw new Error(`Java 运行时下载失败（HTTP ${response.status}）`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  let receivedBytes = 0;
  const readable = Readable.fromWeb(response.body);
  readable.on('data', (chunk) => {
    receivedBytes += chunk.length;
    onProgress({ receivedBytes, totalBytes: size });
  });
  try {
    await pipeline(readable, require('node:fs').createWriteStream(temporary), { signal });
    if (Number.isFinite(size)) {
      const stat = await fs.stat(temporary);
      if (stat.size !== size) throw new Error('Java 运行时文件大小校验失败');
    }
    await fs.rm(destination, { force: true });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const file = await fs.open(filePath, 'r');
  try {
    for await (const chunk of file.createReadStream()) hash.update(chunk);
  } finally {
    await file.close().catch(() => {});
  }
  return hash.digest('hex');
}

async function findJavaInDirectory(root, executableName) {
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === executableName) return candidate;
      if (entry.isDirectory() && depth < 6) queue.push({ directory: candidate, depth: depth + 1 });
    }
  }
  return undefined;
}

class ManagedJavaRuntime {
  constructor({
    gameDirectory,
    extractArchive,
    findSystemJava = findJavaExecutable,
    probeJava = javaMajorVersion,
    fetchRuntimeAssets = fetchJson,
    download = downloadArchive
  } = {}) {
    this.gameDirectory = gameDirectory;
    this.extractArchive = extractArchive;
    this.findSystemJava = findSystemJava;
    this.probeJava = probeJava;
    this.fetchRuntimeAssets = fetchRuntimeAssets;
    this.download = download;
    this.installing = new Map();
  }

  runtimeRoot(majorVersion) {
    return path.join(this.gameDirectory, 'runtime', 'melody', `java-${majorVersion}`);
  }

  async installedExecutable(majorVersion) {
    try {
      const root = this.runtimeRoot(majorVersion);
      const marker = JSON.parse(await fs.readFile(path.join(root, '.melody-runtime.json'), 'utf8'));
      if (marker.schemaVersion !== 1 || marker.majorVersion !== majorVersion) return undefined;
      const executable = path.resolve(root, marker.executable);
      if (!executable.startsWith(`${path.resolve(root)}${path.sep}`)) return undefined;
      return await this.probeJava(executable) === majorVersion ? executable : undefined;
    } catch {
      return undefined;
    }
  }

  async resolve(explicitPath, requiredMajorVersion, onProgress = () => {}, signal) {
    if (!Number.isInteger(requiredMajorVersion)) {
      return this.findSystemJava(explicitPath, requiredMajorVersion);
    }
    try {
      return await this.findSystemJava(explicitPath, requiredMajorVersion);
    } catch {}
    const installed = await this.installedExecutable(requiredMajorVersion);
    if (installed) return installed;
    if (process.platform !== 'win32') {
      throw new Error(`该游戏版本需要 Java ${requiredMajorVersion}，当前系统暂不支持自动安装`);
    }
    if (!this.installing.has(requiredMajorVersion)) {
      this.installing.set(requiredMajorVersion, this.install(requiredMajorVersion, onProgress, signal));
    }
    try {
      return await this.installing.get(requiredMajorVersion);
    } finally {
      this.installing.delete(requiredMajorVersion);
    }
  }

  async install(majorVersion, onProgress, signal) {
    if (typeof this.extractArchive !== 'function') throw new Error('Java 运行时解压服务不可用');
    const os = adoptiumPlatform();
    const architecture = adoptiumArchitecture();
    if (!os || !architecture) throw new Error('当前系统不支持自动安装 Java');
    onProgress({ message: `正在获取 Java ${majorVersion} 运行时…`, majorVersion });
    const apiUrl = `${ADOPTIUM_API}/assets/latest/${majorVersion}/hotspot?architecture=${architecture}&image_type=jre&os=${os}&vendor=eclipse`;
    const runtimePackage = selectRuntimePackage(
      await this.fetchRuntimeAssets(apiUrl, signal),
      majorVersion
    );
    const baseRoot = path.join(this.gameDirectory, 'runtime', 'melody');
    const archivePath = path.join(baseRoot, runtimePackage.name);
    const temporaryRoot = path.join(baseRoot, `.java-${majorVersion}-${process.pid}-${Date.now()}`);
    await fs.mkdir(baseRoot, { recursive: true });
    try {
      onProgress({ message: `正在下载 Java ${majorVersion}…`, majorVersion, totalBytes: runtimePackage.size });
      await this.download(runtimePackage.link, archivePath, {
        signal,
        size: runtimePackage.size,
        onProgress: (progress) => onProgress({
          message: `正在下载 Java ${majorVersion}…`,
          majorVersion,
          ...progress
        })
      });
      if (runtimePackage.checksum && await fileSha256(archivePath) !== runtimePackage.checksum) {
        throw new Error('Java 运行时 SHA-256 校验失败');
      }
      onProgress({ message: `正在安装 Java ${majorVersion}…`, majorVersion });
      await fs.mkdir(temporaryRoot, { recursive: true });
      await this.extractArchive(archivePath, temporaryRoot);
      const executableName = process.platform === 'win32' ? 'java.exe' : 'java';
      const executable = await findJavaInDirectory(temporaryRoot, executableName);
      if (!executable || await this.probeJava(executable) !== majorVersion) {
        throw new Error(`下载的运行时不是有效的 Java ${majorVersion}`);
      }
      const relativeExecutable = path.relative(temporaryRoot, executable);
      await fs.writeFile(path.join(temporaryRoot, '.melody-runtime.json'), `${JSON.stringify({
        schemaVersion: 1,
        majorVersion,
        releaseName: runtimePackage.releaseName,
        executable: relativeExecutable
      }, null, 2)}\n`, 'utf8');
      const finalRoot = this.runtimeRoot(majorVersion);
      await fs.rm(finalRoot, { recursive: true, force: true });
      await fs.rename(temporaryRoot, finalRoot);
      onProgress({ message: `Java ${majorVersion} 安装完成`, majorVersion });
      return path.join(finalRoot, relativeExecutable);
    } finally {
      await fs.rm(archivePath, { force: true }).catch(() => {});
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  ADOPTIUM_API,
  ManagedJavaRuntime,
  adoptiumArchitecture,
  adoptiumPlatform,
  selectRuntimePackage
};
