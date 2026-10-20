const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { UpdateManager, downloadToFile } = require('../src/main/updater/update-manager');
const { TransactionStore, transactionPaths } = require('../src/main/updater/transaction-store');
const { waitForHelper, macReplacementScript, startWindowsHelper } = require('../src/main/updater/install-helper');
const { prepareMacUpdate, readMachOArchitectures } = require('../src/main/updater/macos-preparation');

const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const macho = (cpu = 0x01000007) => {
  const bytes = Buffer.alloc(32); bytes.writeUInt32BE(0xcffaedfe); bytes.writeUInt32LE(cpu, 4); return bytes;
};

async function fixture(t, { platform = 'linux', version = '1.0.0', nextVersion = '2.0.0', directory, target, ...overrides } = {}) {
  directory ??= await fs.mkdtemp(path.join(os.tmpdir(), 'melody-transactions-'));
  if (!overrides.keep) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  target ??= path.join(directory, platform === 'darwin' ? 'My Launcher.app' : platform === 'win32' ? '我的启动器.exe' : '我的启动器.AppImage');
  if (platform !== 'darwin') await fs.writeFile(target, version);
  const bytes = Buffer.from(nextVersion);
  const asset = { name: `Launcher-${platform === 'win32' ? 'Windows-x64.exe' : platform === 'darwin' ? 'macOS-x64.zip' : 'Linux-x64.AppImage'}`,
    browser_download_url: 'https://example.test/update', size: bytes.length, digest: `sha256:${digest(bytes)}` };
  const calls = { quit: 0, relaunch: 0, trash: [] };
  const manager = new UpdateManager({
    app: { isPackaged: true, getVersion: () => version,
      getPath: (key) => key === 'exe' ? path.join(target, 'Contents', 'MacOS', 'Launcher') : path.join(directory, key),
      quit: () => calls.quit++, relaunch: () => calls.relaunch++ },
    platform, arch: 'x64', installationTarget: target,
    shell: { trashItem: async (filePath) => { calls.trash.push(filePath); await fs.unlink(filePath); } },
    env: platform === 'linux' ? { APPIMAGE: target } : platform === 'win32' ? { PORTABLE_EXECUTABLE_FILE: target, PORTABLE_EXECUTABLE_DIR: directory } : {},
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: `v${nextVersion}`, assets: [asset] }) }),
    downloadFile: async (_url, filePath) => fs.writeFile(filePath, bytes),
    ...overrides
  });
  return { manager, calls, directory, target, bytes };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  child.unref = () => { child.detached = true; };
  return child;
}

test('cancelling an update stops mirror failover and waits for the partial file to close', async (t) => {
  let started;
  const begin = new Promise((resolve) => { started = resolve; });
  let attempts = 0;
  const { manager, target } = await fixture(t, { downloadFile: async (_url, filePath, _onProgress, { signal }) => {
    attempts++;
    await fs.writeFile(filePath, 'partial');
    started();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  } });
  const checking = manager.check();
  await begin;
  assert.equal(manager.publicState().canCancel, true);
  const state = await manager.cancel();
  await checking;
  assert.equal(state.status, 'available');
  assert.equal(state.canCancel, false);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(target, 'utf8'), '1.0.0');
  assert.equal((await fs.readdir(path.join(path.dirname(target), '.melody-updates'), { recursive: true })).some((name) => name.endsWith('.part')), false);
});

test('cancelling checksum verification never makes the package installable', async (t) => {
  let started;
  const begin = new Promise((resolve) => { started = resolve; });
  const { manager } = await fixture(t, { hashFile: async (_filePath, signal) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
  } });
  const operation = manager.check();
  await begin;
  assert.equal(manager.publicState().status, 'verifying');
  assert.equal((await manager.cancel()).status, 'available');
  await operation;
  await assert.rejects(manager.install(), /尚未下载完成/);
});

test('helper must send ready before quit; spawn errors, early exits and cancellation keep the app alive', async (t) => {
  const child = fakeChild();
  const { manager, calls } = await fixture(t, { platform: 'win32', spawnProcess: () => child });
  await manager.check();
  const installing = manager.install();
  while (child.listenerCount('error') === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.quit, 0);
  child.emit('error', Object.assign(new Error('PowerShell unavailable'), { code: 'ENOENT' }));
  assert.equal((await installing).status, 'error');
  assert.equal(calls.quit, 0);
  assert.equal(child.killed, true);
  const aborted = new AbortController();
  const waitingChild = fakeChild();
  const waiting = waitForHelper(() => waitingChild, 'test', [], { signal: aborted.signal });
  aborted.abort();
  await assert.rejects(waiting, { code: 'ABORT_ERR' });
  assert.equal(waitingChild.killed, true);
  const early = fakeChild();
  const exited = waitForHelper(() => early, 'test', []);
  early.emit('close', 1);
  await assert.rejects(exited, /未就绪/);
});

test('helper readiness permits quit and update source is rechecked before handoff', async (t) => {
  let spawns = 0;
  const { manager, calls } = await fixture(t, { platform: 'win32', spawnProcess: () => {
    spawns++;
    const child = fakeChild();
    queueMicrotask(() => child.stdout.emit('data', Buffer.from('MELODY_UPDATE_READY\r\n')));
    return child;
  } });
  await manager.check();
  await fs.writeFile(manager.updateFilePath, 'tampered');
  assert.equal((await manager.install()).status, 'error');
  assert.equal(spawns, 0); assert.equal(calls.quit, 0);
  await fs.writeFile(manager.updateFilePath, '2.0.0');
  assert.equal((await manager.recover('retry')).installing, true);
  assert.equal(spawns, 1); assert.equal(calls.quit, 1);
});

test('prepared transactions survive restart; Linux waits for install and keeps exactly one known rollback', async (t) => {
  const first = await fixture(t);
  await first.manager.check();
  const firstRecord = { ...first.manager.transaction };
  assert.equal(await fs.readFile(first.target, 'utf8'), '1.0.0');
  const restored = await fixture(t, { directory: first.directory, target: first.target, keep: true });
  assert.equal((await restored.manager.initialize()).recovery.phase, 'prepared');
  await restored.manager.recover('retry');
  assert.equal(await fs.readFile(first.target, 'utf8'), '2.0.0');
  assert.equal(await fs.readFile(firstRecord.backupPath, 'utf8'), '1.0.0');
  const next = await fixture(t, { directory: first.directory, target: first.target, version: '2.0.0', nextVersion: '3.0.0', keep: true });
  assert.equal((await next.manager.confirmHealthy()).rollbackAvailable, true);
  assert.equal(await fs.readFile(firstRecord.backupPath, 'utf8'), '1.0.0');
  await next.manager.check();
  const secondRecord = { ...next.manager.transaction };
  await next.manager.install();
  const current = await fixture(t, { directory: first.directory, target: first.target, version: '3.0.0', keep: true });
  await current.manager.confirmHealthy();
  await assert.rejects(fs.stat(firstRecord.backupPath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(secondRecord.backupPath, 'utf8'), '2.0.0');
  assert.equal((await current.manager.initialize()).rollbackVersion, '2.0.0');
});

test('unconfirmed startup reports recovery, does not roll back by time, and can restore the known backup', async (t) => {
  const first = await fixture(t);
  await first.manager.check(); await first.manager.install();
  const current = await fixture(t, { directory: first.directory, target: first.target, version: '2.0.0', keep: true });
  const state = await current.manager.initialize();
  assert.equal(state.recovery.phase, 'awaiting-health');
  assert.equal(await fs.readFile(first.target, 'utf8'), '2.0.0');
  await current.manager.recover('rollback');
  assert.equal(await fs.readFile(first.target, 'utf8'), '1.0.0');
});

test('transaction identity isolates different portable paths sharing userData and rejects redirected records', async (t) => {
  const first = await fixture(t, { platform: 'win32' });
  await first.manager.check();
  const other = new TransactionStore({ directory: path.dirname(first.manager.store.filePath), target: `${first.target}-other.exe`, platform: 'win32' });
  await other.load(); assert.equal(other.records.length, 0);
  const report = JSON.parse(await fs.readFile(first.manager.store.filePath, 'utf8'));
  report.records[0].backupPath = path.join(first.directory, 'personal-data');
  await fs.writeFile(first.manager.store.filePath, JSON.stringify(report));
  await assert.rejects(first.manager.store.load(), /路径无效/);
});

test('manual legacy cleanup recycles only selected unchanged files and excludes current/known backups', async (t) => {
  const { manager, directory, target, calls } = await fixture(t, { platform: 'win32' });
  const old = path.join(directory, 'The-Melody-of-Oblivion-Remake-v0.5.0-Windows-x64.exe');
  const changed = path.join(directory, 'The-Melody-of-Oblivion-Remake-v0.6.0-Windows-x64.exe');
  const personal = path.join(directory, 'personal.exe');
  await Promise.all([fs.writeFile(old, 'old'), fs.writeFile(changed, 'before'), fs.writeFile(personal, 'mine')]);
  const entries = await manager.listHistory();
  assert.equal(entries.length, 2);
  await fs.writeFile(changed, 'after');
  const result = await manager.cleanupHistory(entries.map((entry) => entry.id).concat('not-a-candidate'));
  assert.equal(result.removed.length, 1); assert.equal(result.skipped.length, 2);
  assert.deepEqual(calls.trash, [old]);
  assert.equal(await fs.readFile(personal, 'utf8'), 'mine');
  assert.equal(await fs.readFile(target, 'utf8'), '1.0.0');
  assert.equal(await fs.readFile(changed, 'utf8'), 'after');
});

test('macOS prepares one validated bundle with ditto and preserves local data', async (t) => {
  const { manager, target, directory } = await fixture(t, { platform: 'darwin' });
  await fs.mkdir(path.join(target, 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(directory, '.minecraft'), 'world-data');
  const commands = [];
  manager.runCommand = async (command, args) => {
    commands.push(command);
    if (command.endsWith('ditto')) {
      await fs.mkdir(path.join(args[3], 'New Launcher.app', 'Contents', 'MacOS'), { recursive: true });
      await fs.writeFile(path.join(args[3], 'New Launcher.app', 'Contents', 'MacOS', 'Launcher'), macho());
    }
    return { stdout: command.endsWith('plutil') ? JSON.stringify({ CFBundleIdentifier: 'com.melodyofoblivion.launcher', CFBundleShortVersionString: '2.0.0', CFBundleExecutable: 'Launcher' }) : 'x86_64 arm64' };
  };
  manager.startHelper = async ({ record }) => { assert.equal(path.dirname(record.sourcePath), record.stagingRoot); return fakeChild(); };
  await manager.check();
  assert.equal((await manager.install()).installing, true);
  assert.deepEqual(commands, ['/usr/bin/ditto', '/usr/bin/plutil']);
  assert.equal(await fs.readFile(path.join(directory, '.minecraft'), 'utf8'), 'world-data');
});

test('macOS read-only application location falls back to manual installation without quitting', async (t) => {
  const { manager, calls, target } = await fixture(t, { platform: 'darwin' });
  await fs.mkdir(target);
  await manager.check();
  manager.fileSystem = { ...fs, mkdir: async (directory, options) => {
    if (path.basename(directory).startsWith('.melody-write-')) throw Object.assign(new Error('read only'), { code: 'EROFS' });
    return fs.mkdir(directory, options);
  } };
  const state = await manager.install();
  assert.equal(state.status, 'downloaded'); assert.equal(state.installAction, 'open-folder');
  assert.match(state.manualInstallReason, /不可写/); assert.equal(calls.quit, 0);
});

test('macOS rejects wrong bundle identity and architecture before helper handoff', async (t) => {
  const { manager, target } = await fixture(t, { platform: 'darwin' });
  await fs.mkdir(target);
  await manager.check();
  let helper = false;
  manager.startHelper = async () => { helper = true; };
  manager.runCommand = async (command, args) => {
    if (command.endsWith('ditto')) await fs.mkdir(path.join(args[3], 'New.app'), { recursive: true });
    return { stdout: JSON.stringify({ CFBundleIdentifier: 'wrong.app' }) };
  };
  assert.equal((await manager.install()).status, 'error');
  assert.equal(helper, false);
  const record = manager.transaction;
  manager.runCommand = async (command) => ({ stdout: command.endsWith('plutil')
    ? JSON.stringify({ CFBundleIdentifier: 'com.melodyofoblivion.launcher', CFBundleShortVersionString: '2.0.0', CFBundleExecutable: 'Launcher' }) : 'arm64' });
  await fs.mkdir(path.join(record.stagingRoot, 'New.app', 'Contents', 'MacOS'), { recursive: true });
  await fs.writeFile(path.join(record.stagingRoot, 'New.app', 'Contents', 'MacOS', 'Launcher'), macho(0x0100000c));
  await assert.rejects(prepareMacUpdate({ record, fileSystem: fs, runCommand: manager.runCommand, arch: 'x64' }), /架构不匹配/);
  const script = macReplacementScript(record, manager.store.filePath, 0, 42);
  assert.ok(script.indexOf('MELODY_UPDATE_READY') < script.indexOf('while /bin/kill'));
  assert.match(script, /save_phase rolled-back/);
});

test('macOS architecture validation reads universal Mach-O headers without developer tools', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-macho-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'Launcher');
  const universal = Buffer.alloc(128);
  universal.writeUInt32BE(0xcafebabe); universal.writeUInt32BE(2, 4);
  universal.writeUInt32BE(0x01000007, 8); universal.writeUInt32BE(64, 16); universal.writeUInt32BE(32, 20);
  universal.writeUInt32BE(0x0100000c, 28); universal.writeUInt32BE(96, 36); universal.writeUInt32BE(32, 40);
  macho().copy(universal, 64); macho(0x0100000c).copy(universal, 96);
  await fs.writeFile(binary, universal);
  assert.deepEqual(await readMachOArchitectures(fs, binary), ['x64', 'arm64']);
  universal.writeUInt32BE(999999, 36);
  await fs.writeFile(binary, universal);
  await assert.rejects(readMachOArchitectures(fs, binary), /格式无效/);
});

test('managed path generator refuses invalid IDs before constructing cleanup paths', () => {
  assert.throws(() => transactionPaths('/tmp/launcher', '../personal', 'linux'), /标识无效/);
});

test('real streaming cancellation closes the file before returning', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-update-cancel-stream-'));
  const target = path.join(directory, 'update.part');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '1000000' });
    response.write('partial');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const controller = new AbortController();
  const operation = downloadToFile(`http://127.0.0.1:${server.address().port}`, target, () => controller.abort(), { signal: controller.signal });
  await assert.rejects(operation, { name: 'AbortError' });
  await fs.rm(target, { force: true });
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('real Windows helper commits a unique backup and persists awaiting-health before relaunch', { skip: process.platform !== 'win32' }, async (t) => {
  const { manager, target } = await fixture(t, { platform: 'win32' });
  await manager.check();
  const record = manager.transaction;
  const { replacementScript } = require('../src/main/updater/windows-replacement');
  const script = replacementScript(record.sourcePath, target, 0x7fffffff, { backupPath: record.backupPath,
    journalPath: manager.store.filePath, transactionId: record.id, ready: true }).replaceAll(
    'Start-Process -FilePath $destination -WindowStyle Hidden', "[Console]::WriteLine('relaunched')");
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  assert.match(result.stdout, /MELODY_UPDATE_READY/);
  assert.equal(await fs.readFile(target, 'utf8'), '2.0.0');
  assert.equal(await fs.readFile(record.backupPath, 'utf8'), '1.0.0');
  await manager.store.load();
  assert.equal(manager.store.latest().phase, 'awaiting-health');
});

test('managed download rejects a junction redirecting the staging root', { skip: process.platform !== 'win32' }, async (t) => {
  const { manager, directory, target } = await fixture(t, { platform: 'win32' });
  const external = path.join(directory, 'personal-files');
  await fs.mkdir(external);
  await fs.mkdir(path.join(directory, 'Melody'));
  await fs.symlink(external, path.join(directory, 'Melody', 'updates'), 'junction');
  const state = await manager.check();
  assert.equal(state.status, 'error');
  assert.match(state.message, /符号链接/);
  assert.deepEqual(await fs.readdir(external), []);
  assert.equal(await fs.readFile(target, 'utf8'), '1.0.0');
});

test('a real hidden Windows helper can deliver its ready handshake through pipes', { skip: process.platform !== 'win32' }, async () => {
  const script = "[Console]::WriteLine('MELODY_UPDATE_READY'); [Console]::Out.Flush()";
  const child = await waitForHelper(spawn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  assert.ok(child.pid > 0);
});

test('Windows helper survives its Node parent exiting after ready', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-helper-survival-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'after-parent-exit');
  const worker = `const { spawn } = require('node:child_process');
    const { startWindowsHelper } = require(${JSON.stringify(require.resolve('../src/main/updater/install-helper'))});
    const file = process.argv[1].replaceAll("'", "''");
    startWindowsHelper({ directory: require('node:path').dirname(process.argv[1]), spawnProcess: spawn,
      makeScript: ({readyPath, cancelPath}) => "[IO.File]::WriteAllText('" + readyPath.replaceAll("'", "''") + "', 'MELODY_UPDATE_READY'); $p = Get-Process -Id " + process.pid + "; $p.WaitForExit(); if (!(Test-Path -LiteralPath '" + cancelPath.replaceAll("'", "''") + "')) { [IO.File]::WriteAllText('" + file + "', 'survived') }"
    }).catch(error => { console.error(error); process.exitCode = 1; });`;
  await promisify(execFile)(process.execPath, ['-e', worker, marker], { windowsHide: true, timeout: 10000 });
  const deadline = Date.now() + 10000;
  while (!await fs.stat(marker).then(() => true, () => false)) {
    if (Date.now() > deadline) throw new Error('Helper did not survive its parent');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await fs.readFile(marker, 'utf8'), 'survived');
});

test('cancelling before Windows helper readiness signals the surviving helper to stop', { skip: process.platform !== 'win32' }, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-helper-cancel-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const started = path.join(directory, 'started');
  const stopped = path.join(directory, 'stopped');
  const controller = new AbortController();
  const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const installing = startWindowsHelper({ directory, spawnProcess: spawn, signal: controller.signal,
    makeScript: ({ readyPath, cancelPath }) => `[IO.File]::WriteAllText(${literal(started)}, 'started')
Start-Sleep -Milliseconds 500
if (Test-Path -LiteralPath ${literal(cancelPath)}) { [IO.File]::WriteAllText(${literal(stopped)}, 'cancelled'); exit 0 }
[IO.File]::WriteAllText(${literal(readyPath)}, 'MELODY_UPDATE_READY')` });
  const waitFor = async (filePath) => {
    const deadline = Date.now() + 10000;
    while (!await fs.stat(filePath).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error(`Helper did not create ${path.basename(filePath)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await waitFor(started);
  controller.abort();
  await assert.rejects(installing, { code: 'ABORT_ERR' });
  await waitFor(stopped);
  assert.equal(await fs.readFile(stopped, 'utf8'), 'cancelled');
});
