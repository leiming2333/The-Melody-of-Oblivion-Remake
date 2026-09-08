const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEVICE_CODE_ENDPOINT,
  MICROSOFT_SCOPE,
  MicrosoftAuthManager,
  TOKEN_ENDPOINT,
  exchangeMicrosoftForMinecraft,
  hyphenateUuid,
  validateClientId,
  xstsErrorMessage
} = require('../src/main/accounts/microsoft-auth');

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function minecraftExchangeResponses() {
  return [
    jsonResponse({
      Token: 'xbox-token',
      DisplayClaims: { xui: [{ uhs: 'user-hash' }] }
    }),
    jsonResponse({
      Token: 'xsts-token',
      DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '123456789' }] }
    }),
    jsonResponse({ access_token: 'minecraft-token', expires_in: 3600 }),
    jsonResponse({ items: [{ name: 'game_minecraft' }] }),
    jsonResponse({
      id: '0123456789abcdef0123456789abcdef',
      name: 'Player_01',
      skins: [{
        url: 'http://textures.minecraft.net/texture/012345abcdef',
        variant: 'SLIM'
      }]
    })
  ];
}

test('Microsoft 登录使用 Xbox Live 权限而不是 Graph User.Read', () => {
  assert.equal(MICROSOFT_SCOPE, 'XboxLive.signin offline_access');
  assert.equal(MICROSOFT_SCOPE.includes('User.Read'), false);
  assert.equal(validateClientId(CLIENT_ID.toUpperCase()), CLIENT_ID);
  assert.throws(() => validateClientId('not-a-client-id'), /Client ID/);
});

test('未配置公开 Client ID 时拒绝开始 Microsoft 登录', async () => {
  const manager = new MicrosoftAuthManager({ accountStore: {}, clientId: '' });
  await assert.rejects(manager.begin(1), /MELODY_MICROSOFT_CLIENT_ID/);
});

test('Minecraft UUID 与常见 XSTS 错误会转换为可读结果', () => {
  assert.equal(
    hyphenateUuid('0123456789abcdef0123456789abcdef'),
    '01234567-89ab-cdef-0123-456789abcdef'
  );
  assert.match(xstsErrorMessage({ XErr: 2148916233 }), /Xbox 档案/);
  assert.match(xstsErrorMessage({ XErr: 2148916238 }), /儿童账户/);
});

test('Microsoft 令牌可以依次交换为 Xbox、XSTS 与 Minecraft 档案', async () => {
  const responses = minecraftExchangeResponses();
  const requests = [];
  const progress = [];
  const account = await exchangeMicrosoftForMinecraft({
    accessToken: 'microsoft-token',
    clientId: CLIENT_ID,
    refreshToken: 'refresh-token',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return responses.shift();
    },
    onProgress: (entry) => progress.push(entry.phase)
  });

  assert.equal(requests.length, 5);
  assert.equal(JSON.parse(requests[0].options.body).Properties.RpsTicket, 'd=microsoft-token');
  assert.equal(JSON.parse(requests[1].options.body).RelyingParty, 'rp://api.minecraftservices.com/');
  assert.equal(JSON.parse(requests[2].options.body).identityToken, 'XBL3.0 x=user-hash;xsts-token');
  assert.equal(account.name, 'Player_01');
  assert.equal(account.uuid, '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(account.accessToken, 'minecraft-token');
  assert.equal(account.microsoftRefreshToken, 'refresh-token');
  assert.equal(account.skinModel, 'alex');
  assert.equal(account.skinUrl, 'https://textures.minecraft.net/texture/012345abcdef');
  assert.equal(account.xuid, '123456789');
  assert.deepEqual(progress, ['xbox', 'xsts', 'minecraft', 'entitlements', 'profile']);
});

test('Minecraft Services 会明确提示未审核的应用注册', async () => {
  const responses = [
    ...minecraftExchangeResponses().slice(0, 2),
    jsonResponse({
      error: 'UNAUTHORIZED',
      errorMessage: 'Invalid app registration, see https://aka.ms/AppRegInfo for more information'
    }, 401)
  ];

  await assert.rejects(
    exchangeMicrosoftForMinecraft({
      accessToken: 'microsoft-token',
      clientId: CLIENT_ID,
      refreshToken: 'refresh-token',
      fetchImpl: async () => responses.shift()
    }),
    /Minecraft Services 注册审核/
  );
});

test('设备代码登录会等待授权并保存最终 Microsoft 账户', async () => {
  const responses = [
    jsonResponse({
      device_code: 'device-code',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900,
      interval: 5
    }),
    jsonResponse({ error: 'authorization_pending' }, 400),
    jsonResponse({
      access_token: 'microsoft-token',
      refresh_token: 'refresh-token'
    }),
    ...minecraftExchangeResponses()
  ];
  const calls = [];
  const progress = [];
  let savedAccount;
  const manager = new MicrosoftAuthManager({
    accountStore: {
      async upsertMicrosoft(account) {
        savedAccount = account;
        return { currentId: account.id, current: account, accounts: [account] };
      }
    },
    clientId: CLIENT_ID,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    },
    wait: async () => {}
  });

  const started = await manager.begin(7);
  assert.equal(started.userCode, 'ABCD-EFGH');
  const state = await manager.complete(started.sessionId, 7, (entry) => progress.push(entry.phase));
  assert.equal(state.current.name, 'Player_01');
  assert.equal(savedAccount.accessToken, 'minecraft-token');
  assert.equal(calls[0].url, DEVICE_CODE_ENDPOINT);
  assert.equal(new URLSearchParams(calls[0].options.body).get('client_id'), CLIENT_ID);
  assert.equal(calls[1].url, TOKEN_ENDPOINT);
  assert.equal(calls[2].url, TOKEN_ENDPOINT);
  assert.deepEqual(progress, [
    'waiting',
    'xbox',
    'xsts',
    'minecraft',
    'entitlements',
    'profile',
    'saving'
  ]);
  assert.equal(manager.sessions.size, 0);
});
