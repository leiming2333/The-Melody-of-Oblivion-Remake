const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { microsoftClientConfiguration, normalizeConfiguredClientId } = require('../src/main/accounts/microsoft-client-config');
const { SettingsStore } = require('../src/main/settings/settings-store');
const { MicrosoftAuthManager, DEVICE_CODE_ENDPOINT, TOKEN_ENDPOINT } = require('../src/main/accounts/microsoft-auth');
const { BackgroundAccountAuth } = require('../src/main/accounts/background-accounts');
const { registerAccountIpc } = require('../src/main/accounts/ipc');

const CUSTOM_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('missing bundled authentication configuration does not disable settings or an explicitly configured ID', async () => {
  const result = await promisify(execFile)(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const original = Module._load;
    Module._load = function(request, parent, main) {
      if (request.endsWith('microsoft-client-id.json')) throw new Error('optional resource unavailable');
      return original.call(this, request, parent, main);
    };
    const { normalizeSettings } = require('./src/main/settings/settings-store');
    assert.equal(normalizeSettings({ memoryMb: 8192 }).memoryMb, 8192);
    const { microsoftClientConfiguration } = require('./src/main/accounts/microsoft-client-config');
    assert.equal(microsoftClientConfiguration({ settings: { microsoftClientId: '${CUSTOM_ID}' }, environmentClientId: '' }).clientId, '${CUSTOM_ID}');
    assert.equal(microsoftClientConfiguration({ environmentClientId: '${OTHER_ID}' }).clientId, '${OTHER_ID}');
    assert.throws(() => microsoftClientConfiguration({ environmentClientId: '' }), /optional resource unavailable/);
  `], { cwd: path.join(__dirname, '..'), windowsHide: true });
  assert.equal(result.stderr, '');
});

test('Client ID precedence keeps the bundled ID and never infers audit approval', () => {
  const bundled = microsoftClientConfiguration({ environmentClientId: '' });
  assert.equal(bundled.clientId, require('../src/main/accounts/microsoft-client-id.json').clientId);
  assert.equal(bundled.source, 'bundled');
  assert.equal(bundled.approvalStatus, 'unknown');
  const custom = microsoftClientConfiguration({ settings: { microsoftClientId: ` ${CUSTOM_ID.toUpperCase()} ` }, environmentClientId: '' });
  assert.deepEqual(custom, { clientId: CUSTOM_ID, source: 'custom', approvalStatus: 'unknown' });
  const environment = microsoftClientConfiguration({ settings: { microsoftClientId: CUSTOM_ID }, environmentClientId: OTHER_ID });
  assert.deepEqual(environment, { clientId: OTHER_ID, source: 'environment', approvalStatus: 'unknown' });
  assert.throws(() => microsoftClientConfiguration({ settings: { microsoftClientId: CUSTOM_ID }, environmentClientId: 'invalid' }), /Client ID/);
  for (const invalid of ['invalid', null, 123, {}, 'https://example.com']) {
    assert.throws(() => normalizeConfiguredClientId(invalid), /Client ID/);
  }
});

test('custom IDs persist, clear back to bundled behavior, and invalid edits preserve settings', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-client-id-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'settings.json');
  const store = new SettingsStore(filePath);
  await store.update({ microsoftClientId: ` ${CUSTOM_ID.toUpperCase()} `, memoryMb: 8192 });
  assert.equal((await new SettingsStore(filePath).getState()).microsoftClientId, CUSTOM_ID);
  const before = await fs.readFile(filePath, 'utf8');
  await assert.rejects(store.update({ microsoftClientId: 'invalid', memoryMb: 4096 }), /Client ID/);
  assert.equal(await fs.readFile(filePath, 'utf8'), before);
  const cleared = await store.update({ microsoftClientId: '' });
  assert.equal(cleared.microsoftClientId, '');
  assert.equal(cleared.memoryMb, 8192);
});

test('device-code sessions pin their initiating Client ID while refreshing uses the account ID', async () => {
  const requested = [];
  const manager = new MicrosoftAuthManager({ clientId: OTHER_ID, fetchImpl: async (url, options) => {
    requested.push([url, options.body.get('client_id')]);
    return new Response(JSON.stringify(url === DEVICE_CODE_ENDPOINT
      ? { device_code: 'device', user_code: 'ABCD-EFGH' }
      : { error: 'access_denied' }), { status: url === DEVICE_CODE_ENDPOINT ? 200 : 400 });
  } });
  const first = await manager.begin(1, CUSTOM_ID);
  const second = await manager.begin(2, OTHER_ID);
  await assert.rejects(manager.complete(first.sessionId, 1), /授权被拒绝/);
  await assert.rejects(manager.complete(second.sessionId, 2), /授权被拒绝/);
  await assert.rejects(manager.ensureAccount({ type: 'microsoft', microsoftClientId: CUSTOM_ID,
    microsoftRefreshToken: 'refresh', accessTokenExpiresAt: 0 }), /授权被拒绝/);
  assert.deepEqual(requested, [[DEVICE_CODE_ENDPOINT, CUSTOM_ID], [DEVICE_CODE_ENDPOINT, OTHER_ID],
    [TOKEN_ENDPOINT, CUSTOM_ID], [TOKEN_ENDPOINT, OTHER_ID], [TOKEN_ENDPOINT, CUSTOM_ID]]);
});

test('background auth resolves settings before each login and forwards only the effective ID', async () => {
  let current = CUSTOM_ID;
  const auth = new BackgroundAccountAuth({ provider: 'microsoft', clientId: OTHER_ID,
    getClientId: async () => current, getAccountStore() {} });
  const calls = [];
  auth.process.invoke = async (...args) => { calls.push(args); return { sessionId: 'session' }; };
  await auth.begin(7);
  current = OTHER_ID;
  await auth.begin(7);
  assert.deepEqual(calls, [['begin', [7, CUSTOM_ID]], ['begin', [7, OTHER_ID]]]);
  auth.getClientId = async () => { throw new Error('invalid configuration'); };
  await assert.rejects(auth.begin(7), /invalid configuration/);
  assert.equal(calls.length, 2);
});

test('configuration IPC reads the saved setting without creating authentication workers', async (t) => {
  const previous = process.env.MELODY_MICROSOFT_CLIENT_ID;
  process.env.MELODY_MICROSOFT_CLIENT_ID = '';
  t.after(() => {
    if (previous === undefined) delete process.env.MELODY_MICROSOFT_CLIENT_ID;
    else process.env.MELODY_MICROSOFT_CLIENT_ID = previous;
  });
  const handlers = new Map();
  let authRequests = 0;
  registerAccountIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getSettingsStore: () => ({ getState: async () => ({ microsoftClientId: CUSTOM_ID }) }),
    getMicrosoftAuth: () => { authRequests++; } });
  assert.deepEqual(await handlers.get('accounts:microsoft-configuration')(), {
    clientId: CUSTOM_ID, source: 'custom', approvalStatus: 'unknown'
  });
  assert.equal(authRequests, 0);
});

test('Client ID UI exposes the active source and environment override without claiming approval', async () => {
  const { renderMicrosoftClientConfiguration } = await import('../src/renderer/modules/microsoft-client-ui.mjs');
  const elements = { statuses: [{}, {}], input: {} };
  renderMicrosoftClientConfiguration(elements, { clientId: OTHER_ID, source: 'environment', approvalStatus: 'unknown' });
  assert.equal(elements.input.disabled, true);
  assert.match(elements.input.placeholder, /MELODY_MICROSOFT_CLIENT_ID/);
  assert.match(elements.statuses[0].textContent, /环境变量.*审核状态未确认/);
  assert.equal(elements.statuses[1].textContent, elements.statuses[0].textContent);
  renderMicrosoftClientConfiguration(elements, { clientId: CUSTOM_ID, source: 'custom', approvalStatus: 'unknown' });
  assert.equal(elements.input.disabled, false);
  assert.match(elements.statuses[0].textContent, /自定义/);
});
