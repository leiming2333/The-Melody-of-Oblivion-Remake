const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./downloader');

const AUTHLIB_INJECTOR_VERSION = '1.2.8';
const AUTHLIB_INJECTOR_SHA256 = '9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10';
const AUTHLIB_INJECTOR_URLS = Object.freeze([
  'https://authlib-injector.yushi.moe/artifact/56/authlib-injector-1.2.8.jar',
  'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/artifact/56/authlib-injector-1.2.8.jar'
]);
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

class AuthlibInjectorManager {
  constructor({
    gameDirectory,
    fetchImpl = fetch,
    version = AUTHLIB_INJECTOR_VERSION,
    expectedSha256 = AUTHLIB_INJECTOR_SHA256,
    urls = AUTHLIB_INJECTOR_URLS
  } = {}) {
    this.gameDirectory = gameDirectory;
    this.fetchImpl = fetchImpl;
    this.version = version;
    this.expectedSha256 = expectedSha256;
    this.urls = urls;
    this.installing = null;
  }

  artifactPath() {
    return safePath(
      this.gameDirectory,
      'launcher-cache',
      'authlib-injector',
      `authlib-injector-${this.version}.jar`
    );
  }

  async isValid(destination = this.artifactPath()) {
    try {
      const content = await fs.readFile(destination);
      return content.length > 0
        && content.length <= MAX_ARTIFACT_BYTES
        && sha256(content) === this.expectedSha256;
    } catch {
      return false;
    }
  }

  async download(onProgress = () => {}) {
    const destination = this.artifactPath();
    if (await this.isValid(destination)) return destination;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.part`;
    let lastError;

    for (const url of this.urls) {
      try {
        onProgress({
          message: `正在准备 LittleSkin 登录组件 ${this.version}…`,
          version: this.version
        });
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentLength = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_ARTIFACT_BYTES) {
          throw new Error('文件大小异常');
        }
        const content = Buffer.from(await response.arrayBuffer());
        if (content.length === 0 || content.length > MAX_ARTIFACT_BYTES) {
          throw new Error('文件大小异常');
        }
        if (sha256(content) !== this.expectedSha256) {
          throw new Error('SHA-256 校验失败');
        }
        await fs.writeFile(temporary, content);
        await fs.rm(destination, { force: true });
        await fs.rename(temporary, destination);
        onProgress({
          message: 'LittleSkin 登录组件已就绪',
          version: this.version
        });
        return destination;
      } catch (error) {
        lastError = error;
        await fs.rm(temporary, { force: true }).catch(() => {});
      }
    }

    throw new Error(`LittleSkin 登录组件下载失败：${lastError?.message ?? '所有线路均不可用'}`);
  }

  ensureInstalled(onProgress = () => {}) {
    if (!this.installing) {
      this.installing = this.download(onProgress).finally(() => {
        this.installing = null;
      });
    }
    return this.installing;
  }
}

module.exports = {
  AUTHLIB_INJECTOR_SHA256,
  AUTHLIB_INJECTOR_URLS,
  AUTHLIB_INJECTOR_VERSION,
  AuthlibInjectorManager,
  sha256
};
