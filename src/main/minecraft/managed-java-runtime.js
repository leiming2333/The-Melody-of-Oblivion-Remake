const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { findJavaExecutable, javaMajorVersion } = require('./java-runtime');
const { DEFAULT_SEGMENT_CONCURRENCY, downloadFile, throwIfAborted } = require('./downloader');

const ADOPTIUM_API = 'https://api.adoptium.net/v3';
const AZUL_API = 'https://api.azul.com/metadata/v1/zulu';
const SUPPORTED_JAVA_MAJORS = [8, 16, 17, 21, 25];

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
  const packageName = path.basename(String(asset.binary.package.name ?? `java-${requiredMajorVersion}.${platform === 'win32' ? 'zip' : 'tar.gz'}`));
  const ext = platform === 'win32' ? '.zip' : '.tar.gz';
  if (!packageName.toLowerCase().endsWith(ext)) {
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

function azulPlatform(platform = process.platform) {
  return platform === 'darwin' ? 'macos' : adoptiumPlatform(platform);
}

function azulArchitecture(architecture = process.arch) {
  return architecture === 'x64' ? 'x86_64' : adoptiumArchitecture(architecture);
}

function isZuluRuntimePackage(entry, majorVersion, platform, architecture) {
  const osName = { win32: 'win', darwin: 'macosx', linux: 'linux' }[platform];
  const archName = { x64: 'x64', arm64: 'aarch64' }[architecture];
  const extension = platform === 'win32' ? '.zip' : '.tar.gz';
  const name = String(entry?.name ?? '');
  return Number(entry?.java_version?.[0]) === majorVersion
    && name.includes(`-jre${majorVersion}.`)
    && Boolean(osName && archName)
    && name.endsWith(`-${osName}_${archName}${extension}`)
    && (entry.java_package_type === undefined || entry.java_package_type === 'jre')
    && (entry.javafx_bundled === undefined || entry.javafx_bundled === false);
}

function selectZuluRuntimePackage(assets, majorVersion, platform = process.platform, architecture = process.arch) {
  const asset = Array.isArray(assets) ? assets.find((entry) => (
    isZuluRuntimePackage(entry, majorVersion, platform, architecture)
    && entry.java_package_type === 'jre'
    && entry.os === azulPlatform(platform)
    && entry.arch === (architecture === 'x64' ? 'x86' : 'aarch64')
    && entry.hw_bitness === 64
  )) : undefined;
  if (!asset) throw new Error(`未找到适用于当前系统的 Azul Java ${majorVersion} JRE`);
  const link = new URL(String(asset.download_url));
  if (link.protocol !== 'https:' || link.hostname !== 'cdn.azul.com'
    || link.pathname !== `/zulu/bin/${asset.name}` || link.username || link.password) {
    throw new Error('Azul Java 运行时下载地址不安全');
  }
  const checksum = String(asset.sha256_hash ?? '').toLowerCase();
  const size = Number(asset.size);
  if (!/^[a-f0-9]{64}$/.test(checksum) || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('Azul Java 运行时校验信息不完整');
  }
  return {
    checksum,
    link: link.toString(),
    name: path.basename(asset.name),
    releaseName: `Zulu JRE ${asset.java_version.join('.')}`,
    size
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

async function downloadArchive(url, destination, {
  signal, size, segmentConcurrency, onProgress = () => {}
} = {}) {
  let expectedSize = size;
  // Official metadata can lag the CDN file size; SHA-256 still verifies the archive.
  try {
    throwIfAborted(signal);
    const probeSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
      redirect: 'follow',
      signal: probeSignal
    });
    try {
      const contentRange = /^bytes 0-0\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      const serverSize = response.status === 206 && contentRange
        ? Number(contentRange[1])
        : response.status === 200 ? Number(response.headers.get('content-length')) : undefined;
      if (Number.isSafeInteger(serverSize) && serverSize > 0) expectedSize = serverSize;
    } finally {
      if (response.body) await response.body.cancel().catch(() => {});
    }
  } catch {
    throwIfAborted(signal);
  }
  throwIfAborted(signal);
  onProgress({ receivedBytes: 0, totalBytes: expectedSize });
  const result = await downloadFile({
    label: 'Java JRE',
    urls: [url],
    destination,
    size: expectedSize,
    signal,
    segmentConcurrency,
    onBytes: (receivedBytes) => onProgress({ receivedBytes, totalBytes: expectedSize })
  });
  return { ...result, expectedSize };
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
    download = downloadArchive,
    segmentConcurrency = DEFAULT_SEGMENT_CONCURRENCY
  } = {}) {
    this.gameDirectory = gameDirectory;
    this.extractArchive = extractArchive;
    this.findSystemJava = findSystemJava;
    this.probeJava = probeJava;
    this.fetchRuntimeAssets = fetchRuntimeAssets;
    this.download = download;
    this.segmentConcurrency = segmentConcurrency;
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
    throwIfAborted(signal);
    if (!Number.isInteger(requiredMajorVersion)) {
      const executable = await this.findSystemJava(explicitPath, requiredMajorVersion);
      throwIfAborted(signal);
      return executable;
    }
    try {
      const executable = await this.findSystemJava(explicitPath, requiredMajorVersion);
      throwIfAborted(signal);
      return executable;
    } catch {
      throwIfAborted(signal);
    }
    const installed = await this.installedExecutable(requiredMajorVersion);
    throwIfAborted(signal);
    if (installed) return installed;
    throw new Error(`该游戏版本需要 Java ${requiredMajorVersion}，请在设置的 Java 环境旁下载对应运行环境，或选择已安装的 Java ${requiredMajorVersion}`);
  }

  async ensureInstalled(majorVersion, onProgress = () => {}, signal) {
    if (!SUPPORTED_JAVA_MAJORS.includes(majorVersion)) throw new Error('请选择 Java 8、16、17、21 或 25');
    throwIfAborted(signal);
    const installed = await this.installedExecutable(majorVersion);
    throwIfAborted(signal);
    if (installed) return installed;
    const pending = this.installing.get(majorVersion);
    if (pending) return pending;
    const installation = this.install(majorVersion, onProgress, signal);
    this.installing.set(majorVersion, installation);
    try {
      return await installation;
    } finally {
      if (this.installing.get(majorVersion) === installation) this.installing.delete(majorVersion);
    }
  }

  async runtimePackage(majorVersion, provider, signal) {
    throwIfAborted(signal);
    if (provider === 'azul') {
      const query = new URLSearchParams({
        java_version: String(majorVersion),
        os: azulPlatform(),
        arch: azulArchitecture(),
        archive_type: process.platform === 'win32' ? 'zip' : 'tar.gz',
        java_package_type: 'jre',
        javafx_bundled: 'false',
        release_status: 'ga',
        availability_types: 'CA',
        latest: 'true'
      });
      const assets = await this.fetchRuntimeAssets(`${AZUL_API}/packages/?${query}`, signal);
      throwIfAborted(signal);
      const candidate = Array.isArray(assets) ? assets.find((entry) => (
        isZuluRuntimePackage(entry, majorVersion, process.platform, process.arch)
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(entry.package_uuid ?? ''))
      )) : undefined;
      if (!candidate) throw new Error(`Azul 暂无适用的 Java ${majorVersion} JRE`);
      const details = await this.fetchRuntimeAssets(`${AZUL_API}/packages/${candidate.package_uuid}/`, signal);
      throwIfAborted(signal);
      return selectZuluRuntimePackage([details], majorVersion);
    }
    const apiUrl = `${ADOPTIUM_API}/assets/latest/${majorVersion}/hotspot?architecture=${adoptiumArchitecture()}&image_type=jre&os=${adoptiumPlatform()}&vendor=eclipse`;
    const assets = await this.fetchRuntimeAssets(apiUrl, signal);
    throwIfAborted(signal);
    return selectRuntimePackage(assets, majorVersion);
  }

  async install(majorVersion, onProgress, signal) {
    throwIfAborted(signal);
    if (typeof this.extractArchive !== 'function') throw new Error('Java 运行时解压服务不可用');
    const os = adoptiumPlatform();
    const architecture = adoptiumArchitecture();
    if (!os || !architecture) throw new Error('当前系统不支持自动安装 Java');
    onProgress({ message: `正在获取 Java ${majorVersion} 运行时…`, majorVersion });
    const baseRoot = path.join(this.gameDirectory, 'runtime', 'melody');
    let archivePath;
    let runtimePackage;
    const temporaryRoot = path.join(baseRoot, `.java-${majorVersion}-${process.pid}-${Date.now()}`);
    await fs.mkdir(baseRoot, { recursive: true });
    try {
      for (const provider of ['azul', 'adoptium']) {
        try {
          runtimePackage = await this.runtimePackage(majorVersion, provider, signal);
          archivePath = path.join(baseRoot, `.java-${majorVersion}-${runtimePackage.name}`);
          onProgress({ message: `正在下载 Java ${majorVersion} JRE…`, majorVersion, totalBytes: runtimePackage.size });
          const downloadResult = await this.download(runtimePackage.link, archivePath, {
            signal,
            size: runtimePackage.size,
            segmentConcurrency: this.segmentConcurrency,
            onProgress: (progress) => onProgress({
              message: `正在下载 Java ${majorVersion} JRE…`,
              majorVersion,
              ...progress
            })
          });
          throwIfAborted(signal);
          const expectedSize = this.download === downloadArchive
            ? downloadResult.expectedSize : runtimePackage.size;
          if (Number.isFinite(expectedSize)
            && (await fs.stat(archivePath)).size !== expectedSize) {
            throw new Error('Java 运行时文件大小校验失败');
          }
          if (runtimePackage.checksum && await fileSha256(archivePath) !== runtimePackage.checksum) {
            throw new Error('Java 运行时 SHA-256 校验失败');
          }
          throwIfAborted(signal);
          break;
        } catch (error) {
          if (archivePath) await fs.rm(archivePath, { force: true }).catch(() => {});
          throwIfAborted(signal);
          if (error?.name === 'AbortError' || provider === 'adoptium') throw error;
          onProgress({ message: `Azul 源暂不可用，正在切换 Adoptium Java ${majorVersion} JRE…`, majorVersion });
        }
      }
      throwIfAborted(signal);
      onProgress({ message: `正在安装 Java ${majorVersion}…`, majorVersion });
      await fs.mkdir(temporaryRoot, { recursive: true });
      await this.extractArchive(archivePath, temporaryRoot);
      throwIfAborted(signal);
      const executableName = process.platform === 'win32' ? 'java.exe' : 'java';
      const executable = await findJavaInDirectory(temporaryRoot, executableName);
      throwIfAborted(signal);
      if (!executable || await this.probeJava(executable) !== majorVersion) {
        throw new Error(`下载的运行时不是有效的 Java ${majorVersion}`);
      }
      throwIfAborted(signal);
      const relativeExecutable = path.relative(temporaryRoot, executable);
      await fs.writeFile(path.join(temporaryRoot, '.melody-runtime.json'), `${JSON.stringify({
        schemaVersion: 1,
        majorVersion,
        releaseName: runtimePackage.releaseName,
        executable: relativeExecutable
      }, null, 2)}\n`, 'utf8');
      const finalRoot = this.runtimeRoot(majorVersion);
      throwIfAborted(signal);
      await fs.rm(finalRoot, { recursive: true, force: true });
      throwIfAborted(signal);
      await fs.rename(temporaryRoot, finalRoot);
      onProgress({ message: `Java ${majorVersion} 安装完成`, majorVersion });
      return path.join(finalRoot, relativeExecutable);
    } finally {
      if (archivePath) await fs.rm(archivePath, { force: true }).catch(() => {});
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = {
  ADOPTIUM_API,
  AZUL_API,
  ManagedJavaRuntime,
  SUPPORTED_JAVA_MAJORS,
  adoptiumArchitecture,
  adoptiumPlatform,
  selectRuntimePackage,
  selectZuluRuntimePackage
};
