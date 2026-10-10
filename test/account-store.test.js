const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  AccountStore,
  javaUuidHashCode,
  normalizeSkinUrl,
  offlineUuid,
  offlineUuidForSkinModel,
  skinUrlFromProfile,
  validateOfflineName
} = require('../src/main/accounts/account-store');

test('离线 UUID 与 Minecraft Java 规则一致且结果稳定', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
  assert.equal(offlineUuid('Steve'), offlineUuid('Steve'));
});

test('史蒂夫与艾利克斯使用稳定且不同的默认皮肤 UUID', () => {
  const baseUuid = offlineUuid('Player_01');
  const steveUuid = offlineUuidForSkinModel(baseUuid, 'steve');
  const alexUuid = offlineUuidForSkinModel(baseUuid, 'alex');
  assert.notEqual(steveUuid, alexUuid);
  assert.equal(javaUuidHashCode(steveUuid), 0);
  assert.equal(javaUuidHashCode(alexUuid), 1);
});

test('离线用户名校验限制为 3–16 位合法字符', () => {
  assert.equal(validateOfflineName('Player_01'), 'Player_01');
  assert.throws(() => validateOfflineName('玩家'), /3–16/);
  assert.throws(() => validateOfflineName('ab'), /3–16/);
});

test('signing out of Microsoft clears the active selection and retains the saved account', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-microsoft-signout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new AccountStore(path.join(root, 'accounts.json'));
  const before = await store.upsertMicrosoft({
    uuid: '01234567-89ab-cdef-0123-456789abcdef',
    name: 'Player_01', accessToken: 'access', microsoftRefreshToken: 'refresh'
  });

  const signedOut = await store.signOut(before.current.id);
  assert.equal(signedOut.current, null);
  assert.equal(signedOut.currentId, null);
  assert.equal(signedOut.accounts.length, 1);
  assert.equal((await store.getState()).current, null);
  assert.equal((await store.getAccount(before.current.id)).microsoftRefreshToken, 'refresh');
});

test('Microsoft 档案可解析正版皮肤地址并拒绝非官方纹理域名', () => {
  const textureUrl = 'https://textures.minecraft.net/texture/012345abcdef';
  const profile = {
    properties: [{
      name: 'textures',
      value: Buffer.from(JSON.stringify({
        textures: { SKIN: { url: textureUrl } }
      })).toString('base64')
    }]
  };
  assert.equal(skinUrlFromProfile(profile), textureUrl);

  profile.properties[0].value = Buffer.from(JSON.stringify({
    textures: { SKIN: { url: 'http://textures.minecraft.net/texture/012345abcdef' } }
  })).toString('base64');
  assert.equal(skinUrlFromProfile(profile), textureUrl);
  assert.equal(
    normalizeSkinUrl('http://textures.minecraft.net/texture/012345abcdef'),
    textureUrl
  );

  profile.properties[0].value = Buffer.from(JSON.stringify({
    textures: { SKIN: { url: 'https://example.com/not-a-minecraft-skin.png' } }
  })).toString('base64');
  assert.equal(skinUrlFromProfile(profile), undefined);
});

test('LittleSkin 令牌会加密保存且不会暴露给页面', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-yggdrasil-account-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const filePath = path.join(temporaryRoot, 'accounts.json');
  const secretCodec = {
    encode: (value) => `encoded:${Buffer.from(value).toString('base64')}`,
    decode: (value) => value.startsWith('encoded:')
      ? Buffer.from(value.slice('encoded:'.length), 'base64').toString('utf8')
      : value
  };
  const store = new AccountStore(filePath, { secretCodec });
  const publicState = await store.upsertYggdrasil({
    name: 'Player_01',
    uuid: '01234567-89ab-cdef-0123-456789abcdef',
    accessToken: 'little-access-token',
    clientToken: 'little-client-token',
    skinUrl: 'https://littleskin.cn/textures/skin-hash',
    skinModel: 'alex'
  });
  assert.equal(publicState.current.accessToken, undefined);
  assert.equal(publicState.current.clientToken, undefined);
  assert.equal(publicState.current.skinUrl, 'https://littleskin.cn/textures/skin-hash');

  const persisted = await fs.readFile(filePath, 'utf8');
  assert.equal(persisted.includes('little-access-token'), false);
  assert.equal(persisted.includes('little-client-token'), false);
  const privateAccount = await store.getCurrentAccount();
  assert.equal(privateAccount.accessToken, 'little-access-token');
  assert.equal(privateAccount.clientToken, 'little-client-token');
});

test('Microsoft 登录令牌只提供给启动核心，不会暴露给页面', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-microsoft-account-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const filePath = path.join(temporaryRoot, 'accounts.json');
  await fs.writeFile(filePath, JSON.stringify({
    version: 2,
    currentId: 'microsoft:test',
    accounts: [{
      id: 'microsoft:test',
      type: 'microsoft',
      name: '正版玩家',
      uuid: '01234567-89ab-cdef-0123-456789abcdef',
      accessToken: 'secret-access-token',
      clientId: 'secret-client-id',
      xuid: 'secret-xuid'
    }]
  }), 'utf8');

  const store = new AccountStore(filePath);
  const publicState = await store.getState();
  assert.equal(publicState.current.accessToken, undefined);
  assert.equal(publicState.current.clientId, undefined);
  assert.equal(publicState.current.xuid, undefined);
  assert.equal(publicState.accounts[0].accessToken, undefined);

  const launchAccount = await store.getCurrentAccount();
  assert.equal(launchAccount.accessToken, 'secret-access-token');
  assert.equal(launchAccount.clientId, 'secret-client-id');
  assert.equal(launchAccount.xuid, 'secret-xuid');
});

test('Microsoft 访问令牌与刷新令牌会通过系统凭据编码器落盘', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-secret-account-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const filePath = path.join(temporaryRoot, 'accounts.json');
  const secretCodec = {
    encode: (value) => `encoded:${Buffer.from(value).toString('base64')}`,
    decode: (value) => value.startsWith('encoded:')
      ? Buffer.from(value.slice('encoded:'.length), 'base64').toString('utf8')
      : value
  };
  const store = new AccountStore(filePath, { secretCodec });
  const publicState = await store.upsertMicrosoft({
    name: 'Player_01',
    uuid: '01234567-89ab-cdef-0123-456789abcdef',
    accessToken: 'minecraft-access-token',
    accessTokenExpiresAt: Date.now() + 3600000,
    microsoftClientId: '11111111-2222-3333-4444-555555555555',
    microsoftRefreshToken: 'microsoft-refresh-token',
    clientId: '11111111-2222-3333-4444-555555555555',
    xuid: '123456789'
  });
  assert.equal(publicState.current.accessToken, undefined);
  assert.equal(publicState.current.microsoftRefreshToken, undefined);
  assert.equal(publicState.current.accessTokenExpiresAt, undefined);

  const persisted = await fs.readFile(filePath, 'utf8');
  assert.equal(persisted.includes('minecraft-access-token'), false);
  assert.equal(persisted.includes('microsoft-refresh-token'), false);
  assert.match(persisted, /encoded:/);

  const privateAccount = await store.getCurrentAccount();
  assert.equal(privateAccount.accessToken, 'minecraft-access-token');
  assert.equal(privateAccount.microsoftRefreshToken, 'microsoft-refresh-token');
});

test('账户可以持久化、切换和删除', async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-account-test-'));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const store = new AccountStore(path.join(temporaryRoot, 'accounts.json'));

  const firstState = await store.addOffline('Steve');
  assert.equal(firstState.current.name, 'Steve');

  const secondState = await store.addOffline('Alex', 'alex');
  assert.equal(secondState.accounts.length, 2);
  assert.equal(secondState.current.name, 'Alex');
  assert.equal(secondState.current.skinModel, 'alex');

  const selectedState = await store.select(firstState.accounts[0].id);
  assert.equal(selectedState.current.name, 'Steve');

  const switchedState = await store.setSkinModel(firstState.accounts[0].id, 'alex');
  assert.equal(switchedState.current.skinModel, 'alex');

  const finalState = await store.remove(firstState.accounts[0].id);
  assert.equal(finalState.accounts.length, 1);
  assert.equal(finalState.current.name, 'Alex');
});

for (const type of ['microsoft', 'yggdrasil']) {
  const secondSecret = type === 'microsoft' ? 'microsoftRefreshToken' : 'clientToken';
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const id = `${type === 'microsoft' ? 'microsoft' : 'littleskin'}:${uuid}`;
  const secretCodec = {
    encode: (value) => `encoded:${value}`,
    decode: (value) => {
      if (!value.startsWith('encoded:') || value === 'encoded:damaged-ciphertext') {
        throw new Error('Cannot decrypt credentials');
      }
      return value.slice('encoded:'.length);
    }
  };
  const damagedAccount = {
    id, type, uuid, name: 'Player_01',
    accessToken: 'encoded:old-access',
    [secondSecret]: 'encoded:damaged-ciphertext'
  };

  test(`${type} 损坏凭据允许账户恢复且保留原始密文`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-damaged-account-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'accounts.json');
    const offlineAccount = { id: 'offline:steve', type: 'offline', name: 'Steve', uuid: offlineUuid('Steve') };
    const healthyAccount = {
      id: `${type}:healthy`, type, name: 'Player_02',
      uuid: 'fedcba98-7654-3210-fedc-ba9876543210',
      accessToken: 'encoded:healthy-access', [secondSecret]: 'encoded:healthy-secret'
    };
    await fs.writeFile(filePath, JSON.stringify({ currentId: id, accounts: [damagedAccount, offlineAccount, healthyAccount] }));
    const store = new AccountStore(filePath, { secretCodec });

    const state = await store.getState();
    assert.match(state.current.loginError, /重新登录/);
    assert.equal(state.current.accessToken, undefined);
    assert.equal(state.current[secondSecret], undefined);
    assert.equal(Object.getOwnPropertySymbols(state.current).length, 0);
    assert.equal(JSON.stringify(state).includes('ciphertext'), false);
    await assert.rejects(store.getCurrentAccount(), /Player_01.*重新登录/);
    await assert.rejects(store.getAccount(id), /重新登录/);
    assert.equal((await store.getAccount(offlineAccount.id)).name, 'Steve');
    assert.equal((await store.getAccount(healthyAccount.id)).accessToken, 'healthy-access');

    await store.addOffline('NewPlayer');
    const savedAccounts = JSON.parse(await fs.readFile(filePath, 'utf8')).accounts;
    const savedAccount = savedAccounts.find((account) => account.id === id);
    assert.equal(savedAccount.accessToken, damagedAccount.accessToken);
    assert.equal(savedAccount[secondSecret], damagedAccount[secondSecret]);
    assert.equal(savedAccounts.find((account) => account.id === healthyAccount.id).accessToken, healthyAccount.accessToken);
    await store.select(offlineAccount.id);
    assert.equal((await store.getCurrentAccount()).name, 'Steve');
    await store.select(id);
    const removed = await store.remove(id);
    assert.equal(removed.current.name, 'Steve');
    assert.equal(removed.accounts.some((account) => account.id === id), false);
  });

  test(`${type} 重新登录替换损坏凭据并清除错误`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-account-relogin-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const filePath = path.join(root, 'accounts.json');
    await fs.writeFile(filePath, JSON.stringify({ currentId: id, accounts: [damagedAccount] }));
    const store = new AccountStore(filePath, { secretCodec });
    const credentials = { uuid, name: 'Player_01', accessToken: 'new-access', [secondSecret]: 'new-secret' };
    const state = type === 'microsoft'
      ? await store.upsertMicrosoft(credentials)
      : await store.upsertYggdrasil(credentials);

    assert.equal(state.current.loginError, undefined);
    const account = await store.getCurrentAccount();
    assert.equal(account.accessToken, 'new-access');
    assert.equal(account[secondSecret], 'new-secret');
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8')).accounts[0];
    assert.equal(saved.accessToken, 'encoded:new-access');
    assert.equal(saved[secondSecret], 'encoded:new-secret');
  });
}

test('安全存储不可用或旧明文凭据不会阻止离线账户操作', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-unavailable-secrets-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'accounts.json');
  const account = {
    id: 'microsoft:old', type: 'microsoft', name: 'Player_01',
    uuid: '01234567-89ab-cdef-0123-456789abcdef',
    accessToken: 'old-plaintext', microsoftRefreshToken: 'safe-storage:v1:lost-key'
  };
  await fs.writeFile(filePath, JSON.stringify({ currentId: account.id, accounts: [account] }));
  const store = new AccountStore(filePath, {
    secretCodec: {
      decode: () => { throw new Error('Secure storage unavailable'); },
      encode: () => { throw new Error('Secure storage unavailable'); }
    }
  });

  assert.equal((await store.getState()).accounts.length, 1);
  const state = await store.addOffline('Steve');
  assert.equal(state.current.type, 'offline');
  assert.equal((await store.getCurrentAccount()).name, 'Steve');
  const preserved = JSON.parse(await fs.readFile(filePath, 'utf8')).accounts[0];
  assert.equal(preserved.accessToken, account.accessToken);
  assert.equal(preserved.microsoftRefreshToken, account.microsoftRefreshToken);
  assert.equal((await store.remove(account.id)).accounts.length, 1);
});

test('账户文件替换失败时保留现有账户', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-account-save-failure-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'accounts.json');
  const store = new AccountStore(filePath);
  await store.addOffline('Steve');
  const original = await store.getState();
  const originalBytes = await fs.readFile(filePath);
  t.mock.method(fs, 'rename', async () => { throw new Error('Replacement failed'); });

  await assert.rejects(store.addOffline('Alex'), /Replacement failed/);
  assert.deepEqual(await fs.readFile(filePath), originalBytes);
  assert.deepEqual(await store.getState(), original);
});

test('账户保存期间读取始终获得现有文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-account-save-reader-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'accounts.json');
  const store = new AccountStore(filePath);
  await store.addOffline('Steve');
  const original = await store.getState();
  const rename = fs.rename;
  let entered;
  let release;
  const replacementStarted = new Promise((resolve) => { entered = resolve; });
  const replacementAllowed = new Promise((resolve) => { release = resolve; });
  t.mock.method(fs, 'rename', async (...args) => {
    entered();
    await replacementAllowed;
    return rename(...args);
  });

  const saving = store.addOffline('Alex');
  await replacementStarted;
  try {
    assert.deepEqual(await store.getState(), original);
    assert.equal((await store.getCurrentAccount()).name, 'Steve');
  } finally {
    release();
    await saving;
  }
  assert.equal((await store.getCurrentAccount()).name, 'Alex');
});
