const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { AccountStore } = require('../src/main/accounts/account-store');
const { registerAccountIpc } = require('../src/main/accounts/ipc');

function accountIpc(accountStore, yggdrasilAuth) {
  const handlers = new Map();
  registerAccountIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    accountStore,
    yggdrasilAuth
  });
  return { handlers, invoke: (channel, sender, ...args) => handlers.get(channel)({ sender }, ...args) };
}

test('account IPC registers only offline and LittleSkin account operations', () => {
  const { handlers } = accountIpc({});
  assert.deepEqual([...handlers.keys()].sort(), [
    'accounts:get-state', 'accounts:add-offline', 'accounts:login-littleskin',
    'accounts:select-littleskin-profile', 'accounts:select', 'accounts:set-skin-model',
    'accounts:rename', 'accounts:refresh-skin', 'accounts:remove'
  ].sort());
});

test('offline account IPC hides historical Microsoft accounts and preserves encrypted storage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-account-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'accounts.json');
  const codec = {
    encode: (value) => `encoded:${Buffer.from(value).toString('base64')}`,
    decode: (value) => Buffer.from(value.slice('encoded:'.length), 'base64').toString('utf8')
  };
  const legacy = {
    id: 'microsoft:legacy', type: 'microsoft', name: 'Legacy_Player',
    uuid: '01234567-89ab-cdef-0123-456789abcdef',
    accessToken: codec.encode('historical-access-token'),
    microsoftRefreshToken: codec.encode('historical-refresh-token')
  };
  await fs.writeFile(filePath, JSON.stringify({ currentId: legacy.id, accounts: [legacy] }));
  const store = new AccountStore(filePath, { secretCodec: codec });
  const { invoke } = accountIpc(store);
  const initial = await invoke('accounts:get-state', {});
  assert.equal(initial.currentId, null);
  assert.equal(initial.current, null);
  assert.deepEqual(initial.accounts, []);
  const created = await invoke('accounts:add-offline', {}, 'Player_01', 'alex');
  assert.equal(created.current.type, 'offline');
  assert.equal(created.current.skinModel, 'alex');
  assert.equal(created.accounts.length, 1);
  const offlineId = created.currentId;
  await assert.rejects(invoke('accounts:select', {}, legacy.id), /不再支持|不支持|不可用/);
  const renamed = await invoke('accounts:rename', {}, offlineId, 'Player_02');
  assert.equal(renamed.current.name, 'Player_02');
  const remaining = await invoke('accounts:remove', {}, offlineId);
  assert.equal(remaining.currentId, null);
  assert.deepEqual(remaining.accounts, []);
  assert.equal(await store.getCurrentAccount(), null);
  const persisted = await fs.readFile(filePath, 'utf8');
  assert.equal(persisted.includes('historical-access-token'), false);
  assert.equal(persisted.includes('historical-refresh-token'), false);
  assert.deepEqual(JSON.parse(persisted).accounts.find((account) => account.id === legacy.id), {
    ...legacy, skinModel: 'steve'
  });
});

test('LittleSkin IPC keeps login, profile selection and sender-owned cancellation', async () => {
  const calls = [];
  const loginResult = { sessionId: 'session', profiles: [{ id: 'profile' }] };
  const selectedState = { currentId: 'littleskin:profile' };
  const { invoke } = accountIpc({}, {
    login: async (...args) => { calls.push(['login', ...args]); return loginResult; },
    selectProfile: async (...args) => { calls.push(['selectProfile', ...args]); return selectedState; },
    cancelOwner: (...args) => calls.push(['cancelOwner', ...args])
  });
  const sender = new EventEmitter();
  sender.id = 7;
  assert.equal(await invoke('accounts:login-littleskin', sender, 'player@example.com', 'password'), loginResult);
  assert.equal(await invoke('accounts:select-littleskin-profile', sender, 'session', 'profile'), selectedState);
  sender.emit('destroyed');
  assert.deepEqual(calls, [
    ['login', 7, 'player@example.com', 'password'],
    ['selectProfile', 'session', 7, 'profile'],
    ['cancelOwner', 7]
  ]);
});

test('preload retains supported account bridges and removes Microsoft authorization bridges', async () => {
  let environment;
  const calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = (...args) => calls.push(args);
  const source = await fs.readFile(path.join(__dirname, '../src/preload/preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { environment = value; } },
        ipcRenderer,
        webUtils: {}
      };
    }
  });
  for (const method of ['loginMicrosoft', 'beginMicrosoft', 'completeMicrosoft', 'copyMicrosoftCode',
    'cancelMicrosoft', 'onMicrosoftCode', 'onMicrosoftProgress']) {
    assert.equal(environment.accounts[method], undefined);
  }
  environment.accounts.addOffline('Player_01', 'alex');
  environment.accounts.loginLittleSkin('player@example.com', 'password');
  environment.accounts.selectLittleSkinProfile('session', 'profile');
  environment.accounts.refreshSkin('littleskin:player');
  assert.deepEqual(calls, [
    ['accounts:add-offline', 'Player_01', 'alex'],
    ['accounts:login-littleskin', 'player@example.com', 'password'],
    ['accounts:select-littleskin-profile', 'session', 'profile'],
    ['accounts:refresh-skin', 'littleskin:player']
  ]);
  assert.equal(ipcRenderer.eventNames().some((name) => /microsoft/i.test(name)), false);
});
