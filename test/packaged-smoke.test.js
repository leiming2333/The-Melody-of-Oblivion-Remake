const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { verify } = require('../scripts/verify-packaged.cjs');

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
