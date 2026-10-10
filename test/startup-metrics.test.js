const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StartupMetrics } = require('../src/main/startup-metrics');

test('startup report retains early stages and writes only the latest run', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-startup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const metrics = new StartupMetrics();
  metrics.mark('main-entry');
  metrics.attach(root);
  metrics.mark('window-shown');
  metrics.mark('window-shown');
  await metrics.queue;
  const reportPath = path.join(root, 'logs', 'startup-latest.json');
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.deepEqual(report.stages.map((entry) => entry.stage), ['main-entry', 'window-shown']);
  assert.ok(report.stages.every((entry) => entry.elapsedMs >= 0 && entry.processUptimeMs >= 0));
  const next = new StartupMetrics();
  next.attach(root);
  next.mark('main-entry');
  await next.queue;
  assert.equal(JSON.parse(await fs.readFile(reportPath, 'utf8')).stages.length, 1);
});

test('development table reports elapsed and previous-stage intervals without recording new stages', () => {
  const metrics = new StartupMetrics();
  metrics.stages = [{ stage: 'main-entry', elapsedMs: 0 }, { stage: 'window-shown', elapsedMs: 100 }];
  let rows;
  metrics.print({ table: (value) => { rows = value; } });
  assert.deepEqual(rows, [
    { stage: 'main-entry', elapsedMs: 0, sincePreviousMs: 0 },
    { stage: 'window-shown', elapsedMs: 100, sincePreviousMs: 100 }
  ]);
  assert.equal(metrics.stages.length, 2);
});
