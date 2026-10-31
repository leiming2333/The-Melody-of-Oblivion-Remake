const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LITTLE_SKIN_API,
  YggdrasilAuthManager,
  hyphenateProfileId
} = require('../src/main/accounts/yggdrasil-auth');

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function profileResponse(url = 'https://littleskin.cn/textures/skin-hash', model = 'slim') {
  return jsonResponse({
    id: '0123456789abcdef0123456789abcdef',
    name: 'Player_01',
    properties: [{
      name: 'textures',
      value: Buffer.from(JSON.stringify({
        textures: { SKIN: { url, metadata: { model } } }
      })).toString('base64')
    }]
  });
}

test('LittleSkin 单角色账户会完成 Yggdrasil 登录并同步皮肤', async () => {
  const calls = [];
  let saved;
  const manager = new YggdrasilAuthManager({
    accountStore: {
      async upsertYggdrasil(account) {
        saved = account;
        return { currentId: 'littleskin:test', current: account, accounts: [account] };
      },
      async updateYggdrasilTexture(_id, texture) {
        saved = { ...saved, ...texture };
        return { currentId: 'littleskin:test', current: saved, accounts: [saved] };
      }
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/authserver/authenticate')) {
        return jsonResponse({
          accessToken: 'little-access-token',
          clientToken: 'little-client-token',
          selectedProfile: {
            id: '0123456789abcdef0123456789abcdef',
            name: 'Player_01'
          }
        });
      }
      return profileResponse();
    }
  });

  const result = await manager.login('player@example.com', 'password');
  assert.equal(result.state.current.name, 'Player_01');
  assert.equal(saved.uuid, '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(saved.skinUrl, 'https://littleskin.cn/textures/skin-hash');
  assert.equal(saved.skinModel, 'alex');
  assert.equal(calls[0].url, `${LITTLE_SKIN_API}/authserver/authenticate`);
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.agent.name, 'Minecraft');
  assert.equal(request.username, 'player@example.com');
});

test('LittleSkin 多角色账户自动选择未保存的角色', async () => {
  const profiles = [
    { id: '0123456789abcdef0123456789abcdef', name: 'Player_01' },
    { id: 'fedcba9876543210fedcba9876543210', name: 'Player_02' }
  ];
  const responses = [
    jsonResponse({
      accessToken: 'initial-access-token',
      clientToken: 'client-token',
      availableProfiles: profiles
    }),
    jsonResponse({
      accessToken: 'selected-access-token',
      clientToken: 'client-token',
      selectedProfile: profiles[1]
    }),
    profileResponse('https://littleskin.cn/textures/selected', 'classic')
  ];
  let saved;
  const manager = new YggdrasilAuthManager({
    accountStore: {
      async read() {
        return {
          accounts: [
            { type: 'yggdrasil', uuid: '01234567-89ab-cdef-0123-456789abcdef' }
          ]
        };
      },
      async upsertYggdrasil(account) {
        saved = account;
        return { currentId: 'littleskin:selected', current: account, accounts: [account] };
      },
      async updateYggdrasilTexture(_id, texture) {
        saved = { ...saved, ...texture };
        return { currentId: 'littleskin:selected', current: saved, accounts: [saved] };
      }
    },
    fetchImpl: async () => responses.shift()
  });

  const result = await manager.login('player@example.com', 'password');
  assert.equal(result.state.current.name, 'Player_02');
  assert.equal(saved.accessToken, 'selected-access-token');
});

test('LittleSkin UUID 会被规范化且拒绝无效值', () => {
  assert.equal(
    hyphenateProfileId('0123456789abcdef0123456789abcdef'),
    '01234567-89ab-cdef-0123-456789abcdef'
  );
  assert.throws(() => hyphenateProfileId('not-a-uuid'), /UUID/);
});

test('valid LittleSkin credentials are saved before an optional texture request and survive its failure', async () => {
  const profile = { id: '0123456789abcdef0123456789abcdef', name: 'Player_01' };
  let saved;
  const manager = new YggdrasilAuthManager({
    accountStore: { async upsertYggdrasil(account) {
      saved = account;
      return { current: account, accounts: [account] };
    } },
    fetchImpl: async (url) => {
      if (url.endsWith('/authserver/authenticate')) {
        return jsonResponse({ accessToken: 'valid-token', clientToken: 'valid-client', selectedProfile: profile });
      }
      assert.equal(saved.accessToken, 'valid-token', 'token is persisted before optional network work');
      throw new TypeError('synthetic texture service reset');
    }
  });
  assert.equal((await manager.login('player@example.com', 'password')).state.current.accessToken, 'valid-token');
});

test('LittleSkin service failures preserve HTTP and timeout causes without claiming expired credentials', async () => {
  const account = { type: 'yggdrasil', name: 'Player_01', uuid: '01234567-89ab-cdef-0123-456789abcdef',
    accessToken: 'old-token', clientToken: 'old-client' };
  for (const failureAt of ['validate', 'refresh']) {
    const calls = [];
    const manager = new YggdrasilAuthManager({ fetchImpl: async (url) => {
      calls.push(url);
      if (failureAt === 'refresh' && url.endsWith('/validate')) return jsonResponse({}, 403);
      return new Response('<html>Service unavailable</html>', { status: 503 });
    } });
    await assert.rejects(manager.ensureAccount(account), (error) => {
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.equal(error.status, 503);
      assert.equal(error.retryable, true);
      assert.match(error.message, /HTTP 503/);
      assert.doesNotMatch(error.message, /过期/);
      assert.ok(error.cause);
      return true;
    });
    assert.equal(calls.length, failureAt === 'validate' ? 1 : 2);
  }
  const timeout = new DOMException('synthetic timeout', 'TimeoutError');
  const manager = new YggdrasilAuthManager({ fetchImpl: async (url) => {
    if (url.endsWith('/validate')) return jsonResponse({}, 403);
    throw timeout;
  } });
  await assert.rejects(manager.ensureAccount(account), (error) => error.code === 'ETIMEDOUT'
    && error.cause === timeout && /连接超时/.test(error.message));
});

test('only an authentication rejection during LittleSkin refresh reports expired credentials', async () => {
  const manager = new YggdrasilAuthManager({ fetchImpl: async () => jsonResponse({ error: 'ForbiddenOperationException' }, 403) });
  await assert.rejects(manager.ensureAccount({ type: 'yggdrasil', name: 'Player_01',
    uuid: '01234567-89ab-cdef-0123-456789abcdef', accessToken: 'old-token', clientToken: 'old-client' }),
  (error) => error.code === 'YGGDRASIL_AUTH_EXPIRED' && error.status === 403 && /过期/.test(error.message));
});

test('rotated LittleSkin tokens survive texture failure without changing the selected account or existing skin', async (t) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { AccountStore } = require('../src/main/accounts/account-store');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-yggdrasil-refresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new AccountStore(path.join(root, 'accounts.json'));
  const id = (await store.upsertYggdrasil({ name: 'Player_01', uuid: '01234567-89ab-cdef-0123-456789abcdef',
    accessToken: 'old-token', clientToken: 'old-client', skinUrl: 'https://littleskin.cn/textures/previous', skinModel: 'alex' })).currentId;
  const before = await store.getCurrentAccount();
  const offlineId = (await store.addOffline('Steve')).currentId;
  const manager = new YggdrasilAuthManager({ accountStore: store, fetchImpl: async (url) => {
    if (url.endsWith('/validate')) return jsonResponse({}, 403);
    if (url.endsWith('/refresh')) return jsonResponse({ accessToken: 'new-token', clientToken: 'new-client',
      selectedProfile: { id: '0123456789abcdef0123456789abcdef', name: 'Player_01' } });
    throw new TypeError('synthetic texture service reset');
  } });
  const refreshed = await manager.ensureAccount(before);
  assert.equal(refreshed.accessToken, 'new-token');
  assert.equal((await store.getAccount(id)).clientToken, 'new-client');
  assert.equal((await store.getState()).currentId, offlineId);
  assert.equal(refreshed.skinUrl, before.skinUrl);
  assert.equal(refreshed.skinModel, 'alex');
});

test('an optional LittleSkin texture response cannot overwrite newer tokens or resurrect a removed account', async (t) => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { AccountStore } = require('../src/main/accounts/account-store');
  for (const action of ['refresh', 'remove']) {
    await t.test(action, async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-yggdrasil-texture-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const store = new AccountStore(path.join(root, 'accounts.json'));
      const credentials = { name: 'Player_01', uuid: '01234567-89ab-cdef-0123-456789abcdef',
        accessToken: 'first-token', clientToken: 'first-client' };
      let entered;
      let release;
      const requested = new Promise((resolve) => { entered = resolve; });
      const allowed = new Promise((resolve) => { release = resolve; });
      const manager = new YggdrasilAuthManager({ accountStore: store, fetchImpl: async () => {
        entered();
        await allowed;
        return profileResponse();
      } });
      const saving = manager.saveAccount({ ...credentials,
        profile: { id: credentials.uuid, name: credentials.name } });
      await requested;
      const id = (await store.getState()).currentId;
      try {
        if (action === 'refresh') {
          await store.upsertYggdrasil({ ...credentials, accessToken: 'newer-token', clientToken: 'newer-client' });
        } else {
          await store.remove(id);
        }
      } finally { release(); }
      await saving;
      assert.equal((await store.getAccount(id))?.accessToken, action === 'refresh' ? 'newer-token' : undefined);
      if (action === 'refresh') assert.equal((await store.getAccount(id)).skinModel, 'alex');
    });
  }
});

test('LittleSkin response-body failures retain network and JSON error classification', async () => {
  for (const [failure, code] of [
    [new TypeError('synthetic body connection reset'), 'NETWORK_ERROR'],
    [new SyntaxError('synthetic invalid JSON'), 'YGGDRASIL_INVALID_RESPONSE']
  ]) {
    const manager = new YggdrasilAuthManager({ fetchImpl: async () => ({
      status: 200, ok: true, json: async () => { throw failure; }
    }) });
    await assert.rejects(manager.login('player@example.com', 'password'),
      (error) => error.code === code && error.cause === failure);
  }
});
