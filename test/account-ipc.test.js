const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { AccountStore } = require('../src/main/accounts/account-store');
const { registerAccountIpc } = require('../src/main/accounts/ipc');

function accountIpc(accountStore, yggdrasilAuth, options = {}) {
  const handlers = new Map();
  registerAccountIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    accountStore,
    yggdrasilAuth,
    ...options
  });
  return { handlers, invoke: (channel, sender, ...args) => handlers.get(channel)({ sender }, ...args) };
}

test('Microsoft device-code IPC is registered while old token-passing channels stay absent', () => {
  const { handlers } = accountIpc({});
  for (const channel of ['begin-microsoft', 'complete-microsoft', 'copy-microsoft-code']) {
    assert.equal(handlers.has(`accounts:${channel}`), false);
  }
  for (const channel of ['get-state', 'add-offline', 'login-littleskin', 'login-microsoft', 'cancel-microsoft', 'select', 'remove']) {
    assert.equal(handlers.has(`accounts:${channel}`), true);
  }
});

test('offline account IPC preserves encrypted historical Microsoft accounts and public redaction', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-account-ipc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'accounts.json');
  const store = new AccountStore(filePath, {
    secretCodec: {
      encode: (value) => `encoded:${Buffer.from(value).toString('base64')}`,
      decode: (value) => Buffer.from(value.slice('encoded:'.length), 'base64').toString('utf8')
    }
  });
  const legacy = {
    name: 'Legacy_Player',
    uuid: '01234567-89ab-cdef-0123-456789abcdef',
    accessToken: 'historical-access-token',
    microsoftRefreshToken: 'historical-refresh-token',
    microsoftClientId: 'historical-client-id',
    clientId: 'historical-client-id',
    accessTokenExpiresAt: 12345,
    xuid: 'historical-xuid'
  };
  const microsoftId = (await store.upsertMicrosoft(legacy)).currentId;
  const { invoke } = accountIpc(store);
  const created = await invoke('accounts:add-offline', {}, 'Player_01', 'alex');
  assert.equal(created.current.type, 'offline');
  assert.equal(created.current.skinModel, 'alex');
  assert.equal(created.accounts.length, 2);
  const offlineId = created.currentId;
  const selected = await invoke('accounts:select', {}, microsoftId);
  for (const field of ['accessToken', 'microsoftRefreshToken', 'microsoftClientId', 'clientId', 'accessTokenExpiresAt', 'xuid']) {
    assert.equal(selected.current[field], undefined);
    assert.equal(selected.accounts.find((account) => account.id === microsoftId)[field], undefined);
  }
  const renamed = await invoke('accounts:rename', {}, offlineId, 'Player_02');
  assert.equal(renamed.accounts.find((account) => account.id === offlineId).name, 'Player_02');
  const remaining = await invoke('accounts:remove', {}, offlineId);
  assert.equal(remaining.currentId, microsoftId);
  assert.equal(remaining.accounts.length, 1);
  const privateAccount = await store.getCurrentAccount();
  for (const [field, value] of Object.entries(legacy)) assert.equal(privateAccount[field], value);
  const persisted = await fs.readFile(filePath, 'utf8');
  assert.equal(persisted.includes(legacy.accessToken), false);
  assert.equal(persisted.includes(legacy.microsoftRefreshToken), false);
  assert.match(persisted, /encoded:/);
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

test('preload exposes Microsoft login and removable device-code events without token-passing APIs', async () => {
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
  for (const method of ['beginMicrosoft', 'completeMicrosoft', 'copyMicrosoftCode', 'onMicrosoftProgress']) {
    assert.equal(environment.accounts[method], undefined);
  }
  environment.accounts.loginMicrosoft();
  environment.accounts.cancelMicrosoft();
  let received;
  const unsubscribe = environment.accounts.onMicrosoftCode(code => { received = code; });
  ipcRenderer.emit('accounts:microsoft-code', {}, { userCode: 'PUBLIC' });
  assert.equal(received.userCode, 'PUBLIC');
  unsubscribe();
  assert.equal(ipcRenderer.listenerCount('accounts:microsoft-code'), 0);
  environment.accounts.addOffline('Player_01', 'alex');
  environment.accounts.loginLittleSkin('player@example.com', 'password');
  environment.accounts.selectLittleSkinProfile('session', 'profile');
  environment.accounts.refreshSkin('microsoft:legacy');
  assert.deepEqual(calls, [
    ['accounts:login-microsoft'],
    ['accounts:cancel-microsoft'],
    ['accounts:add-offline', 'Player_01', 'alex'],
    ['accounts:login-littleskin', 'player@example.com', 'password'],
    ['accounts:select-littleskin-profile', 'session', 'profile'],
    ['accounts:refresh-skin', 'microsoft:legacy']
  ]);
  assert.equal(ipcRenderer.listenerCount('accounts:microsoft-progress'), 0);
});

test('Microsoft login IPC binds cancellation to its sender and cleans up listeners', async () => {
  const calls = [];
  const sender = new EventEmitter();
  sender.id = 9;
  sender.isDestroyed = () => false;
  sender.send = (...args) => calls.push(args);
  const { invoke } = accountIpc({}, undefined, { getMicrosoftAuth: () => ({
    login: async (owner, notify) => { assert.equal(owner, 9); notify({ userCode: 'PUBLIC' }); return { currentId: 'ms' }; },
    cancelOwner: owner => calls.push(['cancel', owner])
  }) });
  assert.deepEqual(await invoke('accounts:login-microsoft', sender), { currentId: 'ms' });
  assert.equal(sender.listenerCount('destroyed'), 0);
  await invoke('accounts:cancel-microsoft', sender);
  assert.deepEqual(calls, [['accounts:microsoft-code', { userCode: 'PUBLIC' }], ['cancel', 9]]);
});
