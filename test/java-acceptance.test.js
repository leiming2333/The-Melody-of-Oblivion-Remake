const test = require('node:test');
const assert = require('node:assert/strict');
const { ManagedJavaRuntime, selectRuntimePackage } = require('../src/main/minecraft/managed-java-runtime');

test('manual Java errors are actionable and never silently replaced by managed Java', async () => {
  let managed = false;
  const manager = new ManagedJavaRuntime({ gameDirectory: '.', findSystemJava: async () => { throw new Error('需要 Java 21'); } });
  manager.installedExecutable = async () => { managed = true; return 'other-java'; };
  await assert.rejects(manager.resolve('invalid-java', 21), /手动指定.*版本不兼容.*设置/);
  assert.equal(managed, false);
  assert.equal(await manager.resolve(undefined, 21), 'other-java');
});

test('Adoptium fallback requires a valid SHA-256 before downloading', () => {
  const os = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform];
  const architecture = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const name = process.platform === 'win32' ? 'jre.zip' : 'jre.tar.gz';
  const asset = { version: { major: 21 }, binary: { os, architecture, image_type: 'jre',
    package: { name, link: 'https://example.com/jre', checksum: '' } } };
  assert.throws(() => selectRuntimePackage([asset], 21), /校验信息不完整/);
  asset.binary.package.checksum = 'a'.repeat(64);
  assert.equal(selectRuntimePackage([asset], 21).checksum, 'a'.repeat(64));
});
