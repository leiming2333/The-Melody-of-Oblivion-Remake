const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { UpdateManager, percent } = require('../src/main/updater/update-manager');

function fixture(isPackaged = true) {
  const autoUpdater = new EventEmitter();
  autoUpdater.checkForUpdates = async () => {};
  autoUpdater.downloadUpdate = async () => {};
  autoUpdater.quitAndInstall = () => {};
  const handlers = new Map();
  const manager = new UpdateManager({
    app: { isPackaged, getVersion: () => '1.1.2' },
    autoUpdater,
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }
  });
  manager.start();
  return { autoUpdater, handlers, manager };
}

test('更新进度被限制为整数百分比', () => {
  assert.equal(percent(54.6), 55);
  assert.equal(percent(-2), 0);
  assert.equal(percent(120), 100);
});

test('开发模式明确标记为不可更新', async () => {
  const { manager } = fixture(false);
  assert.equal((await manager.check()).status, 'unavailable');
});

test('检查、下载与安装事件会更新公开状态', async () => {
  const { autoUpdater, manager } = fixture();
  await manager.check();
  autoUpdater.emit('update-available', { version: '1.2.0' });
  assert.equal(manager.publicState().availableVersion, '1.2.0');
  await manager.download();
  autoUpdater.emit('download-progress', { percent: 42.4 });
  assert.equal(manager.publicState().progress, 42);
  autoUpdater.emit('update-downloaded', { version: '1.2.0' });
  assert.equal(manager.publicState().status, 'downloaded');
});
