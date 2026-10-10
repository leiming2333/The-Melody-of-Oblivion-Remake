const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { cleanupScript } = require('../src/main/portable-runtime');

test('portable cleanup keeps current, previous, active and unknown data; removes old managed residue', {
  skip: process.platform !== 'win32'
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-runtime-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keys = ['1', '2', '3', '4'].map((digit) => `64-${digit.repeat(64)}`);
  const oldResidue = `${keys[2]}.incomplete-123`;
  const recentResidue = `${keys[2]}.incomplete-456`;
  const names = [...keys, oldResidue, recentResidue, 'nsm1234.tmp', 'personal-files'];
  for (const name of names) {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, '.complete'), name);
    const age = (name === keys[1] ? 2 : 5) * 86400000;
    await fs.utimes(directory, new Date(Date.now() - age), new Date(Date.now() - age));
  }
  await fs.utimes(path.join(root, recentResidue), new Date(), new Date());
  // A live wrapper's named lease must protect even an otherwise removable build.
  const holderScript = String.raw`$m = [Threading.Mutex]::new($false, 'Local\MelodyPortableLive-${keys[3]}'); [Console]::WriteLine('ready'); [Console]::ReadLine() | Out-Null; $m.Dispose()`;
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(holderScript, 'utf16le').toString('base64')], { windowsHide: true });
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => {
    holder.stdout.once('data', resolve);
    holder.once('error', reject);
    holder.once('exit', () => reject(new Error('Lease holder exited before becoming ready')));
  });
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(cleanupScript, 'utf16le').toString('base64')], {
    windowsHide: true, env: { ...process.env, MELODY_RUNTIME_ROOT: root, MELODY_RUNTIME_KEY: keys[0] }
  });
  assert.deepEqual((await fs.readdir(root)).sort(), [keys[0], keys[1], keys[3], recentResidue, 'personal-files'].sort());
  holder.stdin.end('\n');
});
