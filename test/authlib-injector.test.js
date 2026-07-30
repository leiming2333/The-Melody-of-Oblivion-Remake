const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  AUTHLIB_INJECTOR_SHA256,
  AUTHLIB_INJECTOR_URLS,
  AUTHLIB_INJECTOR_VERSION,
  AuthlibInjectorManager,
  sha256
} = require('../src/main/minecraft/authlib-injector');

test('authlib-injector 固定官方发布地址与 SHA-256 校验值', () => {
  assert.equal(AUTHLIB_INJECTOR_VERSION, '1.2.8');
  assert.match(AUTHLIB_INJECTOR_URLS[0], /authlib-injector-1\.2\.8\.jar$/);
  assert.match(AUTHLIB_INJECTOR_SHA256, /^[a-f0-9]{64}$/);
});

test('LittleSkin 登录组件下载后会校验并复用缓存', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-authlib-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const artifact = Buffer.from('test-authlib-injector-artifact');
  let downloads = 0;
  const manager = new AuthlibInjectorManager({
    gameDirectory: temporaryRoot,
    version: 'test',
    expectedSha256: sha256(artifact),
    urls: ['https://example.com/authlib-injector-test.jar'],
    fetchImpl: async () => {
      downloads += 1;
      return new Response(artifact, {
        status: 200,
        headers: { 'content-length': String(artifact.length) }
      });
    }
  });

  const firstPath = await manager.ensureInstalled();
  const secondPath = await manager.ensureInstalled();
  assert.equal(firstPath, secondPath);
  assert.equal(downloads, 1);
  assert.equal(await fs.readFile(firstPath, 'utf8'), artifact.toString());
  assert.equal(await manager.isValid(firstPath), true);
});
