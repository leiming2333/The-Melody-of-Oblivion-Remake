const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { javaDetailsFromVersionOutput, installedJavaExecutable, runJavaInstaller } = require('../src/main/minecraft/java-runtime');

test('Java runtime details normalize architecture aliases and prefer the Windows native encoding', () => {
  assert.deepEqual(javaDetailsFromVersionOutput('    os.arch = amd64\n    sun.arch.data.model = 64\n    file.encoding = UTF-8\n    native.encoding = GBK\n    sun.jnu.encoding = GBK\nopenjdk version "21.0.12"'),
    { majorVersion: 21, architecture: 'x64', bits: 64, nativeEncoding: 'GBK', fileEncoding: 'UTF-8' });
  for (const [raw, architecture, bits] of [['x86', 'ia32', 32], ['i686', 'ia32', 32], ['aarch64', 'arm64', 64], ['armv7l', 'arm', 32]]) {
    const details = javaDetailsFromVersionOutput(`os.arch = ${raw}\nsun.arch.data.model = ${bits}\nsun.jnu.encoding = Cp1252\njava version "1.8.0_512"`);
    assert.equal(details.architecture, architecture);
    assert.equal(details.bits, bits);
    assert.equal(details.majorVersion, 8);
    assert.equal(details.nativeEncoding, 'Cp1252');
  }
});

test('managed Java cannot reuse a different architecture marker and can fall back after a corrupt current marker', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-java-markers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'runtime', 'melody', 'java-8-ia32');
  const legacy = path.join(root, 'runtime', 'melody', 'java-8');
  await fs.mkdir(current, { recursive: true });
  await fs.mkdir(legacy, { recursive: true });
  const marker = { schemaVersion: 1, majorVersion: 8, architecture: 'x64', executable: 'bin/java.exe' };
  await fs.writeFile(path.join(current, '.melody-runtime.json'), JSON.stringify(marker));
  const probe = async () => 8;
  assert.equal(await installedJavaExecutable(root, 8, probe, { architecture: 'ia32' }), undefined);
  await fs.writeFile(path.join(current, '.melody-runtime.json'), JSON.stringify({ ...marker, schemaVersion: 99 }));
  await fs.writeFile(path.join(legacy, '.melody-runtime.json'), JSON.stringify({ ...marker, architecture: 'ia32' }));
  assert.equal(await installedJavaExecutable(root, 8, probe, { architecture: 'ia32' }), path.join(legacy, 'bin/java.exe'));
});

function installerProcess() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal = 'SIGTERM') => { child.kills.push(signal); return true; };
  return child;
}

test('installer cancellation waits for process closure and preserves all output chunks for the log', async () => {
  const child = installerProcess();
  const controller = new AbortController();
  const log = [];
  let settled = false;
  const pending = runJavaInstaller({ javaExecutable: 'fixture-java', installerPath: 'fixture.jar', gameDirectory: '.',
    spawnProcess: () => child, signal: controller.signal, onLog: (channel, chunk) => log.push([channel, chunk.toString()]) });
  const rejected = assert.rejects(pending, { name: 'AbortError' }).then(() => { settled = true; });
  child.stdout.emit('data', Buffer.from('first line\nsecond line\n'));
  child.stderr.emit('data', Buffer.from('failure detail\n'));
  controller.abort();
  await Promise.resolve();
  assert.equal(settled, false, 'staging data must remain until the installer has stopped');
  assert.deepEqual(child.kills, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  await rejected;
  assert.deepEqual(log, [['stdout', 'first line\nsecond line\n'], ['stderr', 'failure detail\n']]);
});

test('installer idle timeout resets on output and reports a retryable failure after stopping', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = installerProcess();
  const pending = runJavaInstaller({ javaExecutable: 'fixture-java', installerPath: 'fixture.jar', gameDirectory: '.',
    spawnProcess: () => child, idleTimeoutMs: 1000 });
  const rejected = assert.rejects(pending, { code: 'INSTALLER_IDLE_TIMEOUT', phase: 'installing-loader', retryable: true });
  t.mock.timers.tick(900);
  child.stdout.emit('data', Buffer.from('still downloading\n'));
  t.mock.timers.tick(900);
  assert.deepEqual(child.kills, []);
  t.mock.timers.tick(101);
  assert.deepEqual(child.kills, ['SIGTERM']);
  t.mock.timers.tick(2000);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  child.emit('close', null, 'SIGKILL');
  await rejected;
});

test('installer nonzero exits preserve their exit code and diagnostic phase', async () => {
  const child = installerProcess();
  const pending = runJavaInstaller({ javaExecutable: 'fixture-java', installerPath: 'fixture.jar', gameDirectory: '.', spawnProcess: () => child });
  const rejected = assert.rejects(pending, { code: 'INSTALLER_FAILED', exitCode: 12, phase: 'installing-loader' });
  child.stderr.emit('data', Buffer.from('upstream install failure\n'));
  child.emit('close', 12);
  await rejected;
});

test('installer output stream failures stop the process without escaping the event loop or releasing it early', async () => {
  const child = installerProcess();
  let settled = false;
  const pending = runJavaInstaller({ javaExecutable: 'fixture-java', installerPath: 'fixture.jar', gameDirectory: '.',
    spawnProcess: () => child });
  const rejected = assert.rejects(pending, { code: 'EPIPE', phase: 'installing-loader', retryable: true })
    .then(() => { settled = true; });
  assert.doesNotThrow(() => child.stdout.emit('error', Object.assign(new Error('pipe failed'), { code: 'EPIPE' })));
  assert.doesNotThrow(() => child.stderr.emit('error', new Error('secondary stream error')));
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(child.kills, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  await rejected;
});

for (const callback of ['onLog', 'onOutput']) {
  test(`installer ${callback} callback errors are reported only after process closure`, async () => {
    const child = installerProcess();
    const pending = runJavaInstaller({ javaExecutable: 'fixture-java', installerPath: 'fixture.jar', gameDirectory: '.',
      spawnProcess: () => child, [callback]: () => { throw Object.assign(new Error('callback failed'), { code: 'EIO' }); } });
    const rejected = assert.rejects(pending, { code: 'EIO', phase: 'installing-loader' });
    assert.doesNotThrow(() => child.stdout.emit('data', Buffer.from('installer progress\n')));
    assert.deepEqual(child.kills, ['SIGTERM']);
    child.emit('close', null, 'SIGTERM');
    await rejected;
  });
}

test('installer cancellation during process creation cannot miss an immediate close event', async () => {
  const child = installerProcess();
  const controller = new AbortController();
  child.kill = () => { child.emit('close', null, 'SIGTERM'); return true; };
  await assert.rejects(runJavaInstaller({ javaExecutable: 'fixture-java', installerPath: 'fixture.jar', gameDirectory: '.',
    signal: controller.signal, spawnProcess: () => { controller.abort(); return child; } }), { name: 'AbortError' });
});

test('failed kill attempts and subsequent child errors preserve cancellation until close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = installerProcess();
  const controller = new AbortController();
  child.kill = (signal = 'SIGTERM') => {
    child.kills.push(signal);
    throw new Error('kill unavailable');
  };
  const pending = runJavaInstaller({ javaExecutable: 'fixture-java', installerPath: 'fixture.jar', gameDirectory: '.',
    signal: controller.signal, spawnProcess: () => child });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  assert.doesNotThrow(() => controller.abort());
  assert.doesNotThrow(() => t.mock.timers.tick(2000));
  assert.doesNotThrow(() => child.emit('error', new Error('first kill error')));
  assert.doesNotThrow(() => child.emit('error', new Error('second kill error')));
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  child.emit('close', null, 'SIGKILL');
  await rejected;
});
