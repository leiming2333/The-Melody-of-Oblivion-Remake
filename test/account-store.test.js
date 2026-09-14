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

test('档案可解析皮肤地址并拒绝非官方纹理域名', () => {
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

test('遗留的 Microsoft 账户会被过滤，不会出现在账户列表', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-microsoft-account-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const filePath = path.join(temporaryRoot, 'accounts.json');
  await fs.writeFile(filePath, JSON.stringify({
    version: 2,
    currentId: 'microsoft:test',
    accounts: [
      {
        id: 'microsoft:test',
        type: 'microsoft',
        name: '正版玩家',
        uuid: '01234567-89ab-cdef-0123-456789abcdef',
        accessToken: 'secret-access-token',
        clientId: 'secret-client-id',
        xuid: 'secret-xuid'
      },
      {
        id: 'offline:offline-player',
        type: 'offline',
        name: 'OfflinePlayer',
        uuid: '01234567-89ab-cdef-0123-456789abcdee',
        skinModel: 'steve'
      }
    ]
  }), 'utf8');

  const store = new AccountStore(filePath);
  const publicState = await store.getState();
  assert.equal(publicState.accounts.length, 1);
  assert.equal(publicState.accounts[0].type, 'offline');
  assert.equal(publicState.current.type, 'offline');
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
