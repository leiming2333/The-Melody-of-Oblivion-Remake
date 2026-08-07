const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SETTINGS,
  SettingsStore,
  normalizeSettings
} = require('../src/main/settings/settings-store');

test('下载线程设置仅接受安全的预设范围', () => {
  assert.equal(normalizeSettings({ downloadConcurrency: 24 }).downloadConcurrency, 24);
  assert.equal(normalizeSettings({ downloadConcurrency: 999 }).downloadConcurrency, 32);
  assert.equal(normalizeSettings({ downloadConcurrency: '8' }).downloadConcurrency, 8);
  assert.equal(normalizeSettings().downloadConcurrency, DEFAULT_SETTINGS.downloadConcurrency);
});

test('下载源设置仅接受自动、BMCLAPI 与官方源', () => {
  assert.equal(normalizeSettings({ downloadSource: 'bmclapi' }).downloadSource, 'bmclapi');
  assert.equal(normalizeSettings({ downloadSource: 'official' }).downloadSource, 'official');
  assert.equal(normalizeSettings({ downloadSource: 'invalid' }).downloadSource, 'auto');
});

test('Java 设置仅保留绝对路径', () => {
  const javaPath = path.resolve('runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  assert.equal(normalizeSettings({ javaPath }).javaPath, path.normalize(javaPath));
  assert.equal(normalizeSettings({ javaPath: 'runtime/bin/java' }).javaPath, '');
  assert.equal(normalizeSettings().javaPath, DEFAULT_SETTINGS.javaPath);
});

test('游戏目录默认使用启动器本地目录且只接受受支持的模式', () => {
  assert.equal(normalizeSettings().gameDirectoryMode, 'local');
  assert.equal(normalizeSettings({ gameDirectoryMode: 'system' }).gameDirectoryMode, 'system');
  assert.equal(normalizeSettings({ gameDirectoryMode: 'other' }).gameDirectoryMode, 'local');
});

test('启动设置可以持久化并自动规范内存值', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'launcher-settings-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const filePath = path.join(temporaryRoot, 'settings.json');
  const store = new SettingsStore(filePath);

  const saved = await store.update({
    javaPath: path.resolve(temporaryRoot, 'runtime', 'bin', 'java.exe'),
    downloadSource: 'official',
    downloadConcurrency: 12,
    memoryMb: 5000,
    autoUpdate: false,
    launcherAutoUpdate: false
  });
  assert.deepEqual(saved, {
    version: 3,
    javaPath: path.resolve(temporaryRoot, 'runtime', 'bin', 'java.exe'),
    gameDirectoryMode: 'local',
    downloadSource: 'official',
    downloadConcurrency: 12,
    memoryMb: 5120,
    autoUpdate: false,
    launcherAutoUpdate: false
  });
  assert.deepEqual(await new SettingsStore(filePath).getState(), saved);
});
