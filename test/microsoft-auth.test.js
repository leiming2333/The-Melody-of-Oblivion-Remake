const test = require('node:test');
const assert = require('node:assert/strict');
const { MicrosoftAuth, CLIENT_ID } = require('../src/main/accounts/microsoft-auth');

function fixture(errors = []) {
  const requests = [], saved = [];
  let clock = 0;
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const store = { upsertMicrosoft: async (account, options) => { saved.push({ account, options }); return { currentId: 'ms' }; },
    getAccount: async () => ({ ...saved.at(-1).account, id: 'ms' }) };
  const auth = new MicrosoftAuth({ accountStore: store, now: () => clock,
    waitImpl: async (ms, _, { signal }) => { signal.throwIfAborted(); clock += ms; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const body = url.endsWith('/devicecode') ? { device_code: 'private', user_code: 'PUBLIC', expires_in: 60, interval: 1 }
        : url.endsWith('/token') ? errors.shift() ?? { access_token: 'ms-token', refresh_token: 'refresh' }
        : url.includes('user.auth') ? { Token: 'xbox-token' }
        : url.includes('xsts.auth') ? { Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'hash', xid: 'xuid' }] } }
        : url.endsWith('login_with_xbox') ? { access_token: 'mc-token', expires_in: 3600 }
        : { id: uuid.replaceAll('-', ''), name: 'Player', skins: [] };
      return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
    } });
  return { auth, requests, saved, uuid };
}

test('device code polling honors pending and slow_down, persists only Minecraft credentials', async () => {
  const { auth, requests, saved } = fixture([{ error: 'authorization_pending' }, { error: 'slow_down' }]);
  const codes = [];
  await auth.login(1, code => codes.push(code));
  assert.deepEqual(codes, [{ userCode: 'PUBLIC', verificationUri: 'https://www.microsoft.com/link', expiresIn: 60 }]);
  assert.equal(requests.filter(r => r.url.endsWith('/token')).length, 3);
  assert.match(requests[0].options.body, new RegExp(CLIENT_ID));
  assert.equal(saved[0].account.accessToken, 'mc-token');
  assert.equal(saved[0].account.microsoftRefreshToken, 'refresh');
  assert.equal(saved[0].account.accessTokenExpiresAt, 3608000);
  assert.equal(auth.sessions.size, 0);
});

test('login cancellation is owner-scoped and prevents persisting the account', async () => {
  const { auth, saved } = fixture();
  await assert.rejects(auth.login(2, () => auth.cancelOwner(2)), /已取消/);
  assert.equal(saved.length, 0);
  assert.equal(auth.sessions.size, 0);
  await auth.login(3, () => auth.cancelOwner(2));
  assert.equal(saved.length, 1);
});

test('denied authorization produces no token-bearing error and allows retry', async () => {
  const { auth, saved } = fixture([{ error: 'access_denied', error_description: 'secret=private' }]);
  await assert.rejects(auth.login(1, () => {}), /用户拒绝授权/);
  assert.equal(saved.length, 0);
  await auth.login(1, () => {});
  assert.equal(saved.length, 1);
});

test('refresh requests share a task without changing the selected account', async () => {
  const { auth, saved, uuid } = fixture();
  const account = { id: 'ms', uuid, microsoftRefreshToken: 'refresh', accessTokenExpiresAt: 0 };
  const a = auth.ensureAccount(account), b = auth.ensureAccount(account);
  assert.equal(a, b);
  assert.equal((await a).accessToken, 'mc-token');
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].options, { select: false });
  const valid = { accessToken: 'valid', accessTokenExpiresAt: 99999999 };
  assert.equal(await auth.ensureAccount(valid), valid);
});
