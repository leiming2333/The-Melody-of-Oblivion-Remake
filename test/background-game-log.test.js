const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { createBackgroundGameLog } = require('../src/main/minecraft/background-game-log');
const { BackgroundDiagnostics } = require('../src/main/background-diagnostics');

test('isolated game logs flush split output and redact credentials before completing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-background-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = await createBackgroundGameLog(root, 'fixture', { accessToken: 'game-secret' });
  t.after(() => log.close('cleanup'));
  log.write('stdout', Buffer.from('Starting game game-'));
  log.write('stdout', Buffer.from('secret\n'));
  log.write('stderr', Buffer.from('最后一行错误\n'));
  await log.close('Exit 1');
  const text = await fs.readFile(log.filePath, 'utf8');
  assert.ok(!text.includes('game-secret'));
  assert.match(text, /\[REDACTED\]/);
  assert.match(text, /最后一行错误/);
  assert.match(text, /Exit 1/);
});

test('oversized pending game output remains bounded and retains later diagnostics', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-background-log-overflow-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = await createBackgroundGameLog(root, 'fixture');
  t.after(() => log.close('cleanup'));
  for (let index = 0; index < 48; index++) log.write('stdout', Buffer.from('noise\n'.repeat(10000)));
  log.write('stderr', Buffer.from('\nFinal error\n'));
  await log.close('Finished');
  const text = await fs.readFile(log.filePath, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 2 * 1024 * 1024);
  assert.match(text, /Output omitted/);
  assert.match(text, /Final error/);
});

test('a crashed game log reports its failure without restarting into a different file or stopping other logs', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-background-log-crash-'));
  const failed = await createBackgroundGameLog(root, 'failed');
  const healthy = await createBackgroundGameLog(root, 'healthy');
  t.after(async () => {
    await Promise.all([failed.close(), healthy.close()]);
    await fs.rm(root, { recursive: true, force: true });
  });
  const pid = Number(path.basename(failed.filePath).match(/-(\d+)-[a-f\d-]+\.log$/i)?.[1]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  process.kill(pid, 'SIGKILL');
  const deadline = Date.now() + 5000;
  while (!failed.writeError && Date.now() < deadline) await delay(20);
  assert.ok(failed.writeError);
  failed.write('stdout', Buffer.from('After failure\n'));
  healthy.write('stderr', Buffer.from('Other game remains available\n'));
  await Promise.all([failed.close(), healthy.close('Finished')]);
  assert.match(await fs.readFile(healthy.filePath, 'utf8'), /Other game remains available/);
  assert.equal((await fs.readdir(path.dirname(failed.filePath))).length, 2);
});

test('diagnostics logging and export run in their own process with native dialog ownership in main', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-background-diagnostics-'));
  const selected = path.join(root, 'report.json');
  const settingsFailure = Object.assign(new Error('settings damaged'), { code: 'CONFIG_CORRUPT' });
  const diagnostics = new BackgroundDiagnostics({
    app: { getPath: () => root, isPackaged: false, getVersion: () => '1.9.8' },
    dialog: { showSaveDialog: async () => ({ filePath: selected }) },
    BrowserWindow: { fromWebContents: () => null },
    getSettingsStore: () => ({ getState: async () => { throw settingsFailure; } })
  });
  t.after(async () => { await diagnostics.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  await diagnostics.record('Bearer sensitive-token');
  const result = await diagnostics.exportReport({}, 'fixture');
  assert.equal(result.filePath, selected);
  const report = JSON.parse(await fs.readFile(selected));
  assert.equal(report.settings.unavailable, 'CONFIG_CORRUPT');
  assert.ok(!JSON.stringify(report).includes('sensitive-token'));
  assert.notEqual(diagnostics.process.worker.child.pid, process.pid);
});
