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

  const result = await manager.login(7, 'player@example.com', 'password');
  assert.equal(result.state.current.name, 'Player_01');
  assert.equal(saved.uuid, '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(saved.skinUrl, 'https://littleskin.cn/textures/skin-hash');
  assert.equal(saved.skinModel, 'alex');
  assert.equal(calls[0].url, `${LITTLE_SKIN_API}/authserver/authenticate`);
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.agent.name, 'Minecraft');
  assert.equal(request.username, 'player@example.com');
});

test('LittleSkin 多角色账户可以在不再次提交密码的情况下选择角色', async () => {
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
      async upsertYggdrasil(account) {
        saved = account;
        return { currentId: 'littleskin:selected', current: account, accounts: [account] };
      }
    },
    fetchImpl: async () => responses.shift()
  });

  const started = await manager.login(9, 'player@example.com', 'password');
  assert.equal(started.needsProfileSelection, true);
  assert.equal(started.profiles.length, 2);
  const state = await manager.selectProfile(started.sessionId, 9, profiles[1].id);
  assert.equal(state.current.name, 'Player_02');
  assert.equal(saved.accessToken, 'selected-access-token');
  assert.equal(manager.sessions.size, 0);
});

test('LittleSkin UUID 会被规范化且拒绝无效值', () => {
  assert.equal(
    hyphenateProfileId('0123456789abcdef0123456789abcdef'),
    '01234567-89ab-cdef-0123-456789abcdef'
  );
  assert.throws(() => hyphenateProfileId('not-a-uuid'), /UUID/);
});
