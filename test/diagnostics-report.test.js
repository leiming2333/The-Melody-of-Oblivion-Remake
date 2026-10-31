const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createDiagnosticsReport, diagnosticText, exportDiagnosticsReport } = require('../src/main/diagnostics-report');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-diagnostics-report-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDirectory = 'C:\\Users\\Private User';
  await fs.mkdir(path.join(root, 'logs'));
  return { root, app: { isPackaged: true, getVersion: () => '1.8.0',
    getPath: (kind) => kind === 'userData' ? root : homeDirectory }, homeDirectory };
}

test('diagnostic text redacts common auth formats, URL credentials and home paths', () => {
  const message = diagnosticText('Authorization: Basic basic-secret\nBearer bearer-secret\n'
    + '--accessToken command-secret --clientToken client-secret token:legacy-secret:uuid\n'
    + 'password="password-secret" client_secret=app-secret apiKey=api-secret userCode=device-secret\n'
    + 'https://example.invalid/path?token=url-secret&code=code-secret&sig=sig-secret\n'
    + 'C:\\Users\\Private User\\game C:/Users/Private User/game C:\\\\Users\\\\Private User\\\\game',
  'C:\\Users\\Private User');
  for (const secret of ['basic-secret', 'bearer-secret', 'command-secret', 'client-secret', 'legacy-secret',
    'password-secret', 'app-secret', 'api-secret', 'device-secret', 'url-secret', 'code-secret', 'sig-secret', 'Private User']) {
    assert.equal(message.includes(secret), false, secret);
  }
  assert.match(message, /\[HOME\]/);
  assert.match(message, /\[REDACTED\]/);
});

test('reports include whitelisted settings and bounded sanitized records without reading account or game logs', async (t) => {
  const { root, app, homeDirectory } = await fixture(t);
  await fs.writeFile(path.join(root, 'accounts.json'), JSON.stringify({ accessToken: 'never-read-account-secret' }));
  await fs.writeFile(path.join(root, 'logs', 'errors-latest.json'), JSON.stringify(Array.from({ length: 60 }, (_, index) => ({
    at: '2026-10-31T00:00:00.000Z', message: `failure ${index}: accessToken=error-secret ${homeDirectory}\\game`,
    account: { name: 'never-export-name', password: 'never-export-password' }
  }))));
  await fs.writeFile(path.join(root, 'logs', 'startup-latest.json'), JSON.stringify({
    startedAt: '2026-10-31T00:00:00.000Z', accessToken: 'never-export-startup-secret',
    stages: [{ stage: 'window-shown', elapsedMs: 30, password: 'never-export-stage-secret' }],
    events: [{ event: 'lazy-service-loaded', service: 'settingsStore', elapsedMs: 40, clientToken: 'never-export-event-secret' }]
  }));
  const opened = [];
  const open = fs.open;
  t.mock.method(fs, 'open', (...args) => { opened.push(args[0]); return open(...args); });
  const report = await createDiagnosticsReport({ app, message: 'Bearer problem-secret',
    now: new Date('2026-10-31T01:02:03.000Z'), getSettings: async () => ({
      version: 3, memoryMb: 8192, downloadSource: 'official', gameDirectoryMode: 'local',
      javaPath: `${homeDirectory}\\jdk\\java.exe`, javaRuntimes: [{ majorVersion: 21, path: 'never-export-java-path' }],
      accounts: [{ name: 'never-export-player', accessToken: 'never-export-settings-secret' }], password: 'never-export-password'
    }) });
  assert.equal(report.generatedAt, '2026-10-31T01:02:03.000Z');
  assert.equal(report.application.version, '1.8.0');
  assert.equal(report.system.arch, process.arch);
  assert.equal(report.settings.memoryMb, 8192);
  assert.equal(report.settings.javaSelection, 'manual');
  assert.deepEqual(report.settings.javaRuntimeMajors, [21]);
  assert.equal(report.errors.entries.length, 50);
  assert.match(report.errors.entries[0].message, /failure 10/);
  assert.equal(report.startup.stages[0].elapsedMs, 30);
  assert.deepEqual(opened, [path.join(root, 'logs', 'errors-latest.json'), path.join(root, 'logs', 'startup-latest.json')]);
  const serialized = JSON.stringify(report);
  for (const secret of ['error-secret', 'problem-secret', 'never-export-', 'never-read-', 'Private User']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('canceling export does not read settings or create a report', async (t) => {
  const { root, app } = await fixture(t);
  const options = { app, dialog: { async showSaveDialog() { return { canceled: true }; } },
    getSettings: async () => { throw new Error('settings must not be loaded on cancel'); } };
  assert.deepEqual(await exportDiagnosticsReport(options), { canceled: true });
  assert.deepEqual(await fs.readdir(root), ['logs']);
});

test('exports remain usable with corrupt settings, malformed logs and oversized startup records', async (t) => {
  const { root, app } = await fixture(t);
  await fs.writeFile(path.join(root, 'logs', 'errors-latest.json'), '{invalid-json-secret');
  await fs.writeFile(path.join(root, 'logs', 'startup-latest.json'), Buffer.alloc(600 * 1024, 120));
  const filePath = path.join(root, 'report.json');
  const ownerWindow = { id: 'synthetic-window' };
  const result = await exportDiagnosticsReport({ app, ownerWindow, dialog: {
    async showSaveDialog(owner, options) {
      assert.equal(owner, ownerWindow);
      assert.equal(options.title, '导出诊断报告');
      return { canceled: false, filePath };
    }
  }, getSettings: async () => { throw Object.assign(new Error('broken settings password=setting-secret'), { code: 'CONFIG_CORRUPT' }); } });
  assert.deepEqual(result, { canceled: false, filePath });
  const report = JSON.parse(await fs.readFile(filePath, 'utf8'));
  assert.equal(report.settings.unavailable, 'CONFIG_CORRUPT');
  assert.equal(report.errors.unavailable, 'INVALID_JSON');
  assert.equal(report.startup.unavailable, 'RECORD_TOO_LARGE');
  assert.equal(JSON.stringify(report).includes('setting-secret'), false);
  assert.equal(JSON.stringify(report).includes('invalid-json-secret'), false);
});

test('a failed export preserves the selected existing file and removes partial output', async (t) => {
  const { root, app } = await fixture(t);
  const filePath = path.join(root, 'report.json');
  await fs.writeFile(filePath, 'existing report');
  const cause = Object.assign(new Error('synthetic replacement denied'), { code: 'EPERM' });
  t.mock.method(fs, 'rename', async () => { throw cause; });
  await assert.rejects(exportDiagnosticsReport({ app,
    dialog: { async showSaveDialog() { return { canceled: false, filePath }; } },
    getSettings: async () => ({ memoryMb: 4096 }) }),
  (error) => error.code === 'EPERM' && error.cause === cause && /诊断报告保存失败/.test(error.message));
  assert.equal(await fs.readFile(filePath, 'utf8'), 'existing report');
  assert.equal((await fs.readdir(root)).some((name) => name.includes('.part-')), false);
});

test('preload exposes diagnostic export through the dedicated IPC channel', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/preload/preload.js'), 'utf8');
  let environment;
  const calls = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = (...args) => { calls.push(args); return { canceled: true }; };
  vm.runInNewContext(source, { require: () => ({ ipcRenderer, webUtils: {},
    contextBridge: { exposeInMainWorld: (_name, value) => { environment = value; } } }) });
  assert.deepEqual(await environment.diagnostics.exportReport('synthetic error'), { canceled: true });
  assert.deepEqual(calls, [['diagnostics:export-report', 'synthetic error']]);
});
