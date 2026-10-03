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

test('读取授权响应时保留超时、断网和无效 JSON 错误', async () => {
  for (const [error, expected] of [
    [new DOMException('timed out', 'TimeoutError'), /连接超时/],
    [new TypeError('connection terminated'), /连接失败.*connection terminated/],
    [new SyntaxError('invalid JSON'), /无效的 JSON 响应/]
  ]) {
    const manager = new MicrosoftAuthManager({
      clientId: CLIENT_ID,
      fetchImpl: async () => ({ ok: true, json: async () => { throw error; } })
    });
    await assert.rejects(manager.begin(1), expected);
    assert.equal(manager.sessions.size, 0);
  }
});

test('取消读取令牌响应不会保存账户，并清理登录会话', async () => {
  let manager;
  let sessionId;
  let saved = false;
  manager = new MicrosoftAuthManager({
    clientId: CLIENT_ID,
    accountStore: { upsertMicrosoft() { saved = true; } },
    fetchImpl: async (url) => url === DEVICE_CODE_ENDPOINT
      ? jsonResponse({ device_code: 'device', user_code: 'ABCD-EFGH' })
      : { ok: true, json: async () => {
        manager.cancel(sessionId, 1);
        throw new DOMException('aborted', 'AbortError');
      } }
  });
  sessionId = (await manager.begin(1)).sessionId;
  await assert.rejects(manager.complete(sessionId, 1), /登录已取消/);
  assert.equal(saved, false);
  assert.equal(manager.sessions.size, 0);
});

test('皮肤备用服务失败不影响登录和过期令牌刷新', async () => {
  for (const refresh of [false, true]) {
    const responses = minecraftExchangeResponses();
    responses[4] = jsonResponse({ id: '0123456789abcdef0123456789abcdef', name: 'Player_01', skins: [] });
    if (refresh) responses.unshift(jsonResponse({ access_token: 'new-ms-token', refresh_token: 'rotated-refresh' }));
    const fetchImpl = async () => {
      if (responses.length) return responses.shift();
      throw new TypeError('skin service unavailable');
    };
    let account;
    if (refresh) {
      const manager = new MicrosoftAuthManager({
        clientId: CLIENT_ID, fetchImpl,
        accountStore: {
          async upsertMicrosoft(value) { account = value; },
          async getAccount() { return account; }
        }
      });
      account = await manager.ensureAccount({ type: 'microsoft', microsoftClientId: CLIENT_ID, microsoftRefreshToken: 'old-refresh', accessTokenExpiresAt: 0 });
      assert.equal(account.microsoftRefreshToken, 'rotated-refresh');
    } else {
      account = await exchangeMicrosoftForMinecraft({ clientId: CLIENT_ID, accessToken: 'ms-token', refreshToken: 'refresh', fetchImpl });
    }
    assert.equal(account.name, 'Player_01');
    assert.equal(account.accessToken, 'minecraft-token');
    assert.equal(account.skinUrl, undefined);
  }
});

test('皮肤备用请求期间取消仍然终止登录', async () => {
  const controller = new AbortController();
  const responses = minecraftExchangeResponses();
  responses[4] = jsonResponse({ id: '0123456789abcdef0123456789abcdef', name: 'Player_01', skins: [] });
  await assert.rejects(exchangeMicrosoftForMinecraft({
    clientId: CLIENT_ID, accessToken: 'ms-token', signal: controller.signal,
    fetchImpl: async () => {
      if (responses.length) return responses.shift();
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    }
  }), /登录已取消/);
});

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
