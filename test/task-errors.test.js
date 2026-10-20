const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskError, serializeTaskError, taskFailure, registerTaskHandler } = require('../src/shared/task-errors');

test('renderer restores error fields after the plain payload crosses contextBridge and preserves listeners', async () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const context = require('node:vm').createContext({});
  require('node:vm').runInContext(source.slice(0, source.indexOf('const bridgeEnvironment =')), context);
  const stop = () => {};
  const complete = { status: 'complete' };
  const api = context.taskApi({ installModpack: async () => JSON.parse(JSON.stringify(taskFailure(
    createTaskError('MODPACK_SESSION_EXPIRED', '会话过期', { phase: 'preparing', retryable: false })))),
    download: async () => complete, onProgress: () => stop });
  await assert.rejects(api.installModpack(), error => error.code === 'MODPACK_SESSION_EXPIRED'
    && error.phase === 'preparing' && error.retryable === false);
  assert.equal(await api.download(), complete);
  assert.equal(api.onProgress(() => {}), stop);
  assert.equal(context.taskApi(undefined), undefined);
});

test('task errors retain machine-readable recovery fields across a JSON IPC payload', () => {
  const error = createTaskError('MODPACK_ARCHIVE_CHANGED', '归档已改变', {
    phase: 'preparing', retryable: false, details: { projectId: 42, fileId: 84, cached: true }
  });
  const payload = JSON.parse(JSON.stringify(taskFailure(error)));
  assert.deepEqual(payload, { __launcherTaskError: { code: 'MODPACK_ARCHIVE_CHANGED', message: '归档已改变',
    phase: 'preparing', retryable: false, details: { projectId: 42, fileId: 84, cached: true } } });
  assert.equal(payload.__launcherTaskError.stack, undefined);
});

test('task payloads redact credentials in messages and nested diagnostic details', () => {
  const secrets = ['bearer-secret', 'access-secret', 'refresh-secret', 'password-secret', 'device-secret', 'user-secret'];
  const error = new Error(`Bearer ${secrets[0]} access_token=${secrets[1]} refresh_token=${secrets[2]} `
    + `password=${secrets[3]} device_code=${secrets[4]} user_code=${secrets[5]}`);
  error.details = { accessToken: 'nested-access', authorization: 'nested-auth', deviceCode: 'nested-device',
    request: { url: 'https://example.com/file?access_token=url-secret',
      failures: ['refresh_token=array-secret', 'ECONNRESET'] }, safeId: 123 };
  const payload = serializeTaskError(error);
  const encoded = JSON.stringify(payload);
  for (const secret of [...secrets, 'nested-access', 'nested-auth', 'nested-device', 'url-secret', 'array-secret']) {
    assert.equal(encoded.includes(secret), false, `${secret} leaked`);
  }
  assert.match(encoded, /REDACTED/);
  assert.equal(payload.details.safeId, 123);
  assert.equal(payload.details.request.failures[1], 'ECONNRESET');
});

test('cancellation normalizes native abort variants without enabling a failed-operation retry', () => {
  for (const error of [Object.assign(new Error('aborted'), { name: 'AbortError' }),
    createTaskError('ABORT_ERR', 'aborted'), new Error('下载已取消')]) {
    const result = serializeTaskError(error, { phase: 'downloading-files' });
    assert.equal(result.code, 'TASK_CANCELLED');
    assert.equal(result.retryable, false);
    assert.equal(result.phase, 'downloading-files');
  }
});

test('legacy errors receive actionable codes while explicit recovery decisions take precedence', () => {
  const examples = [
    ['ENOSPC: no space left on device', 'ENOSPC', true],
    ['EPERM: operation not permitted', 'EACCES', true],
    ['HTTP 503 from mirror', 'NETWORK_ERROR', true],
    ['文件校验失败', 'CHECKSUM_MISMATCH', true],
    ['整合包清单已损坏', 'INVALID_MODPACK', false],
    ['unexpected failure', 'TASK_FAILED', false]
  ];
  for (const [message, code, retryable] of examples) {
    const result = serializeTaskError(new Error(message));
    assert.equal(result.code, code); assert.equal(result.retryable, retryable);
  }
  const explicit = serializeTaskError(createTaskError('NETWORK_ERROR', 'HTTP 403', {
    retryable: false, phase: 'resolving-files'
  }), { phase: 'fallback' });
  assert.equal(explicit.retryable, false);
  assert.equal(explicit.phase, 'resolving-files');
});

test('oversized and cyclic diagnostic data remains bounded and serializable', () => {
  const circular = { files: Array.from({ length: 500 }, (_, index) => `file-${index}`) };
  circular.self = circular;
  circular.work = () => {};
  const result = serializeTaskError(createTaskError('x'.repeat(500), 'x'.repeat(100000), {
    phase: 'x'.repeat(500), details: circular
  }));
  const encoded = JSON.stringify(result);
  assert.ok(result.code.length <= 80);
  assert.ok(result.phase.length <= 100);
  assert.ok(result.message.length <= 8000);
  assert.ok(result.details.files.length < circular.files.length);
  assert.ok(encoded.length < 50000);
});

test('task handlers preserve successful results and envelope synchronous and asynchronous failures', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
  const complete = { status: 'complete', targetId: 'instance-pack' };
  registerTaskHandler(ipcMain, 'minecraft:success', async (_event, input) => {
    assert.equal(input, 'argument'); return complete;
  });
  registerTaskHandler(ipcMain, 'minecraft:sync-failure', () => { throw new Error('HTTP 503'); });
  registerTaskHandler(ipcMain, 'minecraft:async-failure', async () => {
    throw createTaskError('MODPACK_FILE_MISMATCH', '文件校验失败', { phase: 'importing-files', retryable: true });
  });
  assert.equal(await handlers.get('minecraft:success')({}, 'argument'), complete);
  const sync = await handlers.get('minecraft:sync-failure')({});
  assert.equal(sync.__launcherTaskError.code, 'NETWORK_ERROR');
  assert.equal(sync.__launcherTaskError.phase, 'sync-failure');
  const asynchronous = await handlers.get('minecraft:async-failure')({});
  assert.equal(asynchronous.__launcherTaskError.code, 'MODPACK_FILE_MISMATCH');
  assert.equal(asynchronous.__launcherTaskError.phase, 'importing-files');
  assert.equal(asynchronous.__launcherTaskError.retryable, true);
});
