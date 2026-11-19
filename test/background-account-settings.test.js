const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { BackgroundAccounts, BackgroundAccountAuth } = require('../src/main/accounts/background-accounts');
const { BackgroundSettings } = require('../src/main/settings/background-settings');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-account-settings-'));
  const modules = [];
  t.after(async () => {
    await Promise.allSettled(modules.map((module) => module.dispose()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const own = (module) => { modules.push(module); return module; };
  return { root, own };
}

function codec(overrides = {}) {
  return {
    encode: async (value) => `test-protected:${Buffer.from(value).toString('base64')}`,
    decode: async (value) => {
      if (!value.startsWith('test-protected:')) throw new Error('Stored credentials are unreadable');
      return Buffer.from(value.slice('test-protected:'.length), 'base64').toString();
    }, ...overrides
  };
}

const microsoft = { uuid: '5627dd98-e6be-3c21-b8a8-e92344183641', name: 'Steve',
  accessToken: 'fixture-access-secret', microsoftRefreshToken: 'fixture-refresh-secret' };

test('settings prepare, updates and backup recovery run in an independent process', async (t) => {
  const f = await fixture(t);
  const filePath = path.join(f.root, 'settings.json');
  const settings = f.own(new BackgroundSettings(filePath));
  assert.equal(settings.process.worker, null);
  assert.equal((await settings.prepare()).memoryMb, 4096);
  assert.notEqual(settings.process.worker.child.pid, process.pid);
  await settings.update({ memoryMb: 8192, downloadConcurrency: 8 });
  await settings.update({ memoryMb: 12288 });
  const backup = JSON.parse(await fs.readFile(`${filePath}.bak`, 'utf8'));
  await fs.writeFile(filePath, '{broken');
  const recovered = await settings.getState();
  assert.equal(recovered.memoryMb, backup.memoryMb);
  assert.equal(recovered.downloadConcurrency, 8);
  assert.ok(recovered.recovery);
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).memoryMb, backup.memoryMb);
});

test('offline account operations preserve serialized writes while settings use a different process', async (t) => {
  const f = await fixture(t);
  const accounts = f.own(new BackgroundAccounts(path.join(f.root, 'accounts.json'), { secretCodec: codec() }));
  const settings = f.own(new BackgroundSettings(path.join(f.root, 'settings.json')));
  await Promise.all([accounts.prepare(), settings.prepare()]);
  assert.notEqual(accounts.process.worker.child.pid, settings.process.worker.child.pid);
  await Promise.all([accounts.addOffline('PlayerOne', 'steve'), accounts.addOffline('PlayerTwo', 'alex')]);
  const state = await accounts.getState();
  assert.deepEqual(state.accounts.map((account) => account.name), ['PlayerOne', 'PlayerTwo']);
  const first = state.accounts[0];
  assert.equal((await accounts.select(first.id)).current.name, 'PlayerOne');
  assert.equal((await accounts.renameAccount(first.id, 'Renamed')).current.name, 'Renamed');
  assert.equal((await settings.update({ memoryMb: 8192 })).memoryMb, 8192);
});

test('account storage awaits main-process credential encryption and only public state reaches UI callers', async (t) => {
  const f = await fixture(t);
  const filePath = path.join(f.root, 'accounts.json');
  const baseCodec = codec();
  let encodes = 0, decodes = 0;
  const accounts = f.own(new BackgroundAccounts(filePath, { secretCodec: {
    async encode(value) { encodes++; await new Promise(resolve => setTimeout(resolve, 1)); return baseCodec.encode(value); },
    async decode(value) { decodes++; await new Promise(resolve => setTimeout(resolve, 1)); return baseCodec.decode(value); }
  } }));
  await accounts.prepare();
  const saved = await accounts.upsertMicrosoft(microsoft);
  assert.equal(saved.current.accessToken, undefined);
  assert.equal(saved.current.microsoftRefreshToken, undefined);
  const account = await accounts.getCurrentAccount();
  assert.equal(account.accessToken, microsoft.accessToken);
  assert.equal(account.microsoftRefreshToken, microsoft.microsoftRefreshToken);
  const persisted = await fs.readFile(filePath, 'utf8');
  assert.ok(!persisted.includes(microsoft.accessToken));
  assert.ok(!persisted.includes(microsoft.microsoftRefreshToken));
  assert.ok(!persisted.includes('[object Promise]'));
  assert.match(JSON.parse(persisted).accounts[0].accessToken, /^test-protected:/);
  assert.ok(encodes >= 2 && decodes >= 2);
});

test('unreadable online credentials retain their ciphertext during unrelated offline writes', async (t) => {
  const f = await fixture(t);
  const filePath = path.join(f.root, 'accounts.json');
  const baseCodec = codec();
  let canRead = true;
  const accounts = f.own(new BackgroundAccounts(filePath, { secretCodec: {
    encode: baseCodec.encode,
    decode: (value) => {
      if (!canRead) throw new Error('Credential vault unavailable');
      return baseCodec.decode(value);
    }
  } }));
  await accounts.upsertMicrosoft(microsoft);
  const original = JSON.parse(await fs.readFile(filePath, 'utf8')).accounts[0];
  canRead = false;
  const state = await accounts.getState();
  assert.match(state.accounts[0].loginError, /登录凭据不可用/);
  await assert.rejects(accounts.getAccount(state.accounts[0].id), /登录凭据不可用/);
  await accounts.addOffline('OfflineNew');
  const retained = JSON.parse(await fs.readFile(filePath, 'utf8')).accounts.find((account) => account.type === 'microsoft');
  assert.equal(retained.accessToken, original.accessToken);
  assert.equal(retained.microsoftRefreshToken, original.microsoftRefreshToken);
  canRead = true;
  assert.equal((await accounts.getAccount(retained.id)).accessToken, microsoft.accessToken);
});

test('unrecoverable settings corruption leaves account operations usable and preserves damaged bytes', async (t) => {
  const f = await fixture(t);
  const filePath = path.join(f.root, 'settings.json');
  await fs.writeFile(filePath, '{damaged-settings');
  const settings = f.own(new BackgroundSettings(filePath));
  const accounts = f.own(new BackgroundAccounts(path.join(f.root, 'accounts.json'), { secretCodec: codec() }));
  await assert.rejects(settings.prepare(), { code: 'CONFIG_CORRUPT' });
  assert.equal(await fs.readFile(filePath, 'utf8'), '{damaged-settings');
  assert.equal((await accounts.addOffline('StillWorks')).current.name, 'StillWorks');
});

test('Microsoft and LittleSkin auth modules validate independently and preserve no-op account refreshes without network', async (t) => {
  const f = await fixture(t);
  const unexpectedStore = () => { throw new Error('Validation must not access account storage'); };
  const microsoftAuth = f.own(new BackgroundAccountAuth({ provider: 'microsoft', clientId: null, getAccountStore: unexpectedStore }));
  const littleSkinAuth = f.own(new BackgroundAccountAuth({ provider: 'yggdrasil', getAccountStore: unexpectedStore }));
  await assert.rejects(microsoftAuth.begin(1), /Microsoft 登录未配置/);
  await assert.rejects(littleSkinAuth.login('', ''), /请输入 LittleSkin 邮箱或角色名/);
  const offline = { type: 'offline', name: 'Steve' };
  assert.deepEqual(await microsoftAuth.ensureAccount(offline), offline);
  assert.deepEqual(await littleSkinAuth.ensureAccount(offline), offline);
  assert.deepEqual(await microsoftAuth.cancel('unknown-session', 1), { cancelled: false });
  assert.notEqual(microsoftAuth.process.worker.child.pid, littleSkinAuth.process.worker.child.pid);
});
