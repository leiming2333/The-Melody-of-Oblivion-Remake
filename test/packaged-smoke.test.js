const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { verify } = require('../scripts/verify-packaged.cjs');
const { writeUpgradeFailureReport } = require('../scripts/verify-upgrade.cjs');

async function script(t, body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-smoke-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.cjs');
  await fs.writeFile(file, body);
  return file;
}

test('package verification requires a native packaged report, not just exit code zero', async t => {
  const valid = await script(t, `require('fs').writeFileSync(process.env.MELODY_SMOKE_RESULT,
    JSON.stringify({ ok: true, packaged: true, platform: process.platform, arch: process.arch, version: 'fixture' }));`);
  assert.equal((await verify(process.execPath, [valid])).ok, true);
  const missing = await script(t, 'process.exit(0);');
  await assert.rejects(verify(process.execPath, [missing]), /ENOENT/);
  const unpackaged = await script(t, `require('fs').writeFileSync(process.env.MELODY_SMOKE_RESULT,
    JSON.stringify({ ok: true, packaged: false, platform: process.platform, arch: process.arch }));`);
  await assert.rejects(verify(process.execPath, [unpackaged]), /does not match/);
});

test('package verification rejects failed and stalled binaries', async t => {
  const failed = await script(t, 'process.exit(7);');
  await assert.rejects(verify(process.execPath, [failed]), /code=7/);
  const stalled = await script(t, 'setInterval(() => {}, 1000);');
  await assert.rejects(verify(process.execPath, [stalled], { timeoutMs: 500 }), /timed out/);
});

test('package verification checks the requested artifact architecture when the host can run another architecture', async t => {
  const reportedArch = process.arch === 'ia32' ? 'x64' : 'ia32';
  const binary = await script(t, `require('fs').writeFileSync(process.env.MELODY_SMOKE_RESULT,
    JSON.stringify({ ok: true, packaged: true, platform: process.platform, arch: '${reportedArch}' }));`);
  await assert.rejects(verify(process.execPath, [binary]), /does not match/);
  assert.equal((await verify(process.execPath, [binary], { expectedArch: reportedArch })).arch, reportedArch);
  const wrongPlatform = await script(t, `require('fs').writeFileSync(process.env.MELODY_SMOKE_RESULT,
    JSON.stringify({ ok: true, packaged: true, platform: 'another-platform', arch: '${reportedArch}' }));`);
  await assert.rejects(verify(process.execPath, [wrongPlatform], { expectedArch: reportedArch }), /does not match/);
});

test('package verification rejects an incorrect embedded version and saves evidence bound to the final artifact', async t => {
  const binary = await script(t, `require('fs').writeFileSync(process.env.MELODY_SMOKE_RESULT,
    JSON.stringify({ ok: true, packaged: true, platform: process.platform, arch: process.arch, version: '1.2.3' }));`);
  await assert.rejects(verify(process.execPath, [binary], { expectedVersion: '1.2.4' }), /does not match/);
  const reportPath = path.join(path.dirname(binary), 'report.json');
  const report = await verify(process.execPath, [binary], { expectedVersion: '1.2.3', reportPath, artifactPath: binary });
  assert.equal(report.artifact, path.basename(binary));
  assert.match(report.artifactSha256, /^[a-f\d]{64}$/);
  assert.deepEqual(JSON.parse(await fs.readFile(reportPath)), report);
});

test('upgrade failure report preserves the original error when journals are locked, malformed or unreadable', async t => {
  const file = await script(t, '');
  const directory = path.dirname(file);
  const userData = path.join(directory, 'user-data');
  const permissionUserData = path.join(directory, 'permission-user-data');
  const updates = path.join(userData, 'updates');
  await fs.mkdir(updates, { recursive: true });
  const locked = path.join(updates, 'locked.json');
  await fs.writeFile(locked, '{}');
  await fs.writeFile(path.join(updates, 'malformed.json'), '{');
  await fs.writeFile(path.join(updates, 'readable.json'), JSON.stringify({ schema: 1, records: [{ phase: 'failed' }] }));
  const originalError = Object.assign(new Error('original upgrade failure'), { code: 'UPGRADE_FAILED' });
  const reportPath = path.join(directory, 'reports', 'upgrade-windows-arm64.json');
  const fileSystem = { ...fs,
    readdir: async filename => {
      if (filename === path.join(permissionUserData, 'updates')) throw Object.assign(new Error('permission store unavailable'), { code: 'EACCES' });
      return fs.readdir(filename);
    },
    readFile: async (filename, options) => {
      if (filename === locked) throw Object.assign(new Error('journal is busy'), { code: 'EBUSY' });
      return fs.readFile(filename, options);
    }
  };
  await writeUpgradeFailureReport({ reportPath, error: originalError, target: 'windows-arm64', directory,
    helperOutput: 'original helper output', userDataDirectories: [userData, permissionUserData] }, fileSystem);
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  assert.equal(report.ok, false);
  assert.equal(report.message, originalError.message);
  assert.equal(report.errorCode, originalError.code);
  assert.equal(report.helperOutput, 'original helper output');
  assert.equal(report.transactions.length, 1);
  assert.equal(report.transactions[0].journal, 'readable.json');
  assert.equal(report.transactions[0].records[0].phase, 'failed');
  assert.equal(report.diagnosticErrors.length, 3);
  assert.ok(report.diagnosticErrors.some(error => error.code === 'EBUSY' && error.path === locked));
  assert.ok(report.diagnosticErrors.some(error => error.operation === 'list-journals' && error.code === 'EACCES'));
  assert.ok(report.diagnosticErrors.some(error => error.path.endsWith('malformed.json')));
});

test('failure report write errors are recorded without replacing the upgrade error', async t => {
  const file = await script(t, '');
  const directory = path.dirname(file);
  const originalError = Object.assign(new Error('installation failed before reporting'), { code: 'UPGRADE_FAILED' });
  const report = await writeUpgradeFailureReport({ reportPath: path.join(directory, 'upgrade.json'), error: originalError,
    target: 'windows-arm64', directory, helperOutput: '', userDataDirectories: [] }, { ...fs,
    writeFile: async () => { throw Object.assign(new Error('report is read only'), { code: 'EACCES' }); }
  });
  assert.equal(report.message, originalError.message);
  assert.equal(report.errorCode, originalError.code);
  assert.equal(report.diagnosticErrors[0].operation, 'write-failure-report');
  assert.equal(report.diagnosticErrors[0].code, 'EACCES');
});
