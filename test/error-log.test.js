const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ErrorLog, redactError } = require('../src/main/error-log');

test('error logs redact credential fields, authorization headers and JWTs', () => {
  const message = redactError('accessToken=secret password: "pass" --refresh-token old Bearer credential eyJabc.abc.xyz');
  for (const secret of ['secret', 'pass"', ' old', 'credential', 'eyJabc']) assert.ok(!message.includes(secret));
});

test('error log is bounded and writes asynchronously', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-error-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const log = new ErrorLog(directory);
  for (let i = 0; i < 55; i++) void log.record('failure ' + i);
  await log.queue;
  const entries = JSON.parse(await fs.readFile(log.filePath, 'utf8'));
  assert.equal(entries.length, 50);
  assert.equal(entries[0].message, 'failure 5');
});
