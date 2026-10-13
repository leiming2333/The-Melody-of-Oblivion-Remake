const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { acquireSingleInstance } = require('../src/main/single-instance');

test('second launcher activation restores and focuses the existing window', () => {
  const app = new EventEmitter();
  app.requestSingleInstanceLock = () => true;
  const actions = [];
  const window = { isDestroyed: () => false, isMinimized: () => true,
    restore: () => actions.push('restore'), show: () => actions.push('show'), focus: () => actions.push('focus') };
  const BrowserWindow = { getAllWindows: () => [{ isDestroyed: () => true }, window] };
  assert.equal(acquireSingleInstance(app, BrowserWindow), true);
  app.emit('second-instance');
  assert.deepEqual(actions, ['restore', 'show', 'focus']);
  BrowserWindow.getAllWindows = () => [];
  assert.doesNotThrow(() => app.emit('second-instance'));
});

test('reopening a launcher without windows creates one after readiness, once', async () => {
  let ready;
  const readiness = new Promise((resolve) => { ready = resolve; });
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: () => readiness
  });
  const windows = [];
  let created = 0;
  acquireSingleInstance(app, { getAllWindows: () => windows }, () => {
    created += 1;
    windows.push({ isDestroyed: () => false });
  });
  app.emit('second-instance');
  app.emit('second-instance');
  assert.equal(created, 0);
  ready();
  await readiness;
  assert.equal(created, 1);
});

test('a launcher without the process lock exits before creating a window or loading stores', () => {
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    const Module = require('node:module');
    const load = Module._load;
    let quit = false;
    const app = Object.assign(new EventEmitter(), {
      requestSingleInstanceLock: () => false, quit: () => { quit = true; },
      setAppUserModelId() {}, whenReady: () => { throw new Error('unexpected initialization'); }
    });
    Module._load = function(name, ...args) {
      if (name === 'electron') return { app, ipcMain: { on() {}, handle() {} },
        BrowserWindow: class { constructor() { throw new Error('unexpected window'); } } };
      return load.call(this, name, ...args);
    };
    require('./src/main/main');
    assert.equal(quit, true);
    for (const name of ['accounts/account-store', 'settings/settings-store'])
      assert.equal(require.cache[require.resolve('./src/main/' + name)], undefined);
  `], { cwd: path.resolve(__dirname, '..'), timeout: 10000 });
});
