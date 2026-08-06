const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  launcherDirectory,
  resolveGameDirectory,
  systemGameDirectory
} = require('../src/main/minecraft/ipc');

function fakeApp({ packaged = true } = {}) {
  return {
    isPackaged: packaged,
    getAppPath: () => path.resolve('project'),
    getPath(name) {
      return {
        appData: path.resolve('app-data'),
        exe: path.resolve('portable', 'launcher.exe'),
        home: path.resolve('home')
      }[name];
    }
  };
}

test('本地目录优先使用便携版启动器所在目录', () => {
  const app = fakeApp();
  const directory = launcherDirectory(app, {
    env: { PORTABLE_EXECUTABLE_DIR: path.resolve('usb', 'launcher') },
    platform: 'win32'
  });
  assert.equal(directory, path.resolve('usb', 'launcher'));
  assert.equal(
    resolveGameDirectory(app, 'local', {
      env: { PORTABLE_EXECUTABLE_DIR: path.resolve('usb', 'launcher') },
      platform: 'win32'
    }),
    path.resolve('usb', 'launcher', '.minecraft')
  );
});

test('开发环境把本地游戏目录放在项目根目录', () => {
  const app = fakeApp({ packaged: false });
  assert.equal(
    resolveGameDirectory(app, 'local', { env: {}, platform: 'win32' }),
    path.resolve('project', '.minecraft')
  );
});

test('系统目录模式保留各平台默认位置', () => {
  const app = fakeApp();
  assert.equal(systemGameDirectory(app, 'win32'), path.resolve('app-data', '.minecraft'));
  assert.equal(
    systemGameDirectory(app, 'darwin'),
    path.resolve('home', 'Library', 'Application Support', 'minecraft')
  );
  assert.equal(systemGameDirectory(app, 'linux'), path.resolve('home', '.minecraft'));
});
