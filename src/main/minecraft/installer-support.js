const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runFileExclusive } = require('../file-write-queue');
const { fetchWithTimeout } = require('./source-manager');
const { safePath, throwIfAborted } = require('./downloader');

function checksumError(code, message, details, retryable = false) {
  return Object.assign(new Error(message), { code, phase: 'verifying-installer', details, retryable });
}

// Mirror metadata is useful for discovery, but executable installers must be
// checked against a digest fetched independently from their official Maven.
async function fetchTrustedInstallerChecksum(officialUrl, signal) {
  const artifact = new URL(officialUrl);
  if (artifact.protocol !== 'https:' || artifact.username || artifact.password
      || !['maven.minecraftforge.net', 'maven.neoforged.net'].includes(artifact.hostname)) {
    throw checksumError('INSTALLER_CHECKSUM_INVALID', '安装器官方校验地址不安全');
  }
  for (const [algorithm, length] of [['sha256', 64], ['sha1', 40]]) {
    throwIfAborted(signal);
    const url = `${officialUrl}.${algorithm}`;
    try {
      const digest = await fetchWithTimeout(url, {
        signal,
        validateRedirect: (redirectUrl) => {
          const target = new URL(redirectUrl);
          if (target.origin !== artifact.origin || target.username || target.password) {
            throw checksumError('INSTALLER_CHECKSUM_INVALID', '安装器校验地址跳转到了非官方来源', { url });
          }
        }
      }, 10000, async (response) => {
        if ([404, 410].includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          return undefined;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw checksumError('NETWORK_ERROR', `安装器官方校验信息获取失败（HTTP ${response.status}）`, { url }, true);
        }
        const text = (await response.text()).trim();
        const match = new RegExp(`^([a-f0-9]{${length}})(?:[ \\t]+\\*?[^\\r\\n]+)?$`, 'i').exec(text);
        if (text.length > 4096 || !match) {
          throw checksumError('INSTALLER_CHECKSUM_INVALID', `安装器官方 ${algorithm.toUpperCase()} 校验信息无效`, { url });
        }
        return match[1].toLowerCase();
      });
      if (digest) return { algorithm, digest };
    } catch (error) {
      throwIfAborted(signal);
      if (['NETWORK_ERROR', 'INSTALLER_CHECKSUM_INVALID'].includes(error.code)) throw error;
      throw checksumError('NETWORK_ERROR', `无法获取安装器官方校验信息：${error.message}`, { url }, true);
    }
  }
  throw checksumError('INSTALLER_CHECKSUM_UNAVAILABLE', '官方没有提供可用的安装器校验信息，已停止安装');
}

async function verifyInstallerChecksum(installerPath, checksum, signal) {
  if (!['sha256', 'sha1'].includes(checksum?.algorithm)
      || !new RegExp(`^[a-f0-9]{${checksum.algorithm === 'sha256' ? 64 : 40}}$`, 'i').test(checksum?.digest ?? '')) {
    throw checksumError('INSTALLER_CHECKSUM_INVALID', '安装器校验信息无效，已停止安装');
  }
  throwIfAborted(signal);
  const hash = crypto.createHash(checksum.algorithm);
  const handle = await fs.open(installerPath, 'r');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  throwIfAborted(signal);
  if (hash.digest('hex') !== checksum.digest.toLowerCase()) {
    await fs.rm(installerPath, { force: true });
    throw checksumError('CHECKSUM_MISMATCH', '安装器文件校验失败，已删除损坏缓存，请重试', {
      algorithm: checksum.algorithm
    }, true);
  }
}

async function ensureLauncherProfiles(gameDirectory, signal) {
  const profilePath = safePath(gameDirectory, 'launcher_profiles.json');
  return runFileExclusive(profilePath, async () => {
    throwIfAborted(signal);
    for (const name of ['launcher_profiles.json', 'launcher_profiles_microsoft_store.json']) {
      try {
        await fs.access(safePath(gameDirectory, name));
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await fs.mkdir(path.dirname(profilePath), { recursive: true });
    throwIfAborted(signal);
    let handle;
    try {
      handle = await fs.open(profilePath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return;
      throw error;
    }
    try {
      await handle.writeFile(`${JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

module.exports = { ensureLauncherProfiles, fetchTrustedInstallerChecksum, verifyInstallerChecksum };
