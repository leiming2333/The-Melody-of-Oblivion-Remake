const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createGameLog } = require('../src/main/minecraft/game-log');
const { MinecraftLauncher } = require('../src/main/minecraft/launch-core');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-game-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('game logs redact credentials split across chunks and preserve both output channels', async (t) => {
  const root = await fixture(t);
  const log = await createGameLog(root, 'base', {
    accessToken: 'known-secret', clientToken: 'client-secret'
  });
  log.write('stdout', Buffer.from('Starting game; raw known-'));
  log.write('stdout', Buffer.from('secret\n--accessToken split-'));
  log.write('stdout', Buffer.from('credential\nBearer bearer-secret\n'));
  log.write('stderr', Buffer.from('clientToken="client-secret" token:session-secret:uuid\n'));
  log.write('stderr', Buffer.from('password: "escaped\\\"password"\nJWT eyJheader.payload.signature\nJava error: main class missing'));
  await log.close('Exit 1');
  const output = await fs.readFile(log.filePath, 'utf8');
  for (const secret of ['known-secret', 'split-credential', 'bearer-secret', 'client-secret', 'session-secret', 'eyJheader', 'escaped']) {
    assert.ok(!output.includes(secret), secret);
  }
  assert.ok(output.includes('[stdout] Starting game'));
  assert.ok(output.includes('[stderr] Java error: main class missing'));
  assert.ok(output.includes('[REDACTED]'));
  if (process.platform !== 'win32') assert.equal((await fs.stat(log.filePath)).mode & 0o777, 0o600);
});

test('large output keeps a bounded tail, handles UTF-8 chunk boundaries, and discards oversized secret lines', async (t) => {
  const root = await fixture(t);
  const log = await createGameLog(root, 'base', {}, { maxBytes: 1024 });
  log.write('stdout', Buffer.from(`--accessToken ${'sensitive'.repeat(2000)}`));
  log.write('stdout', Buffer.from('\n'));
  await log.flush();
  const oversized = await fs.readFile(log.filePath, 'utf8');
  assert.ok(oversized.includes('[Oversized output line omitted]'));
  assert.ok(!oversized.includes('sensitive'));
  for (let index = 0; index < 100; index += 1) {
    log.write('stdout', Buffer.from(`old entry ${index}: normal output\n`));
  }
  const diagnostic = Buffer.from('最后一条错误：无法加载主类\n');
  log.write('stderr', diagnostic.subarray(0, 2));
  log.write('stderr', diagnostic.subarray(2));
  await log.close('Exit 1');
  const output = await fs.readFile(log.filePath, 'utf8');
  assert.ok(Buffer.byteLength(output) <= 1024);
  assert.ok(log.content.length <= 1024);
  assert.ok(output.includes('Earlier output omitted'));
  assert.ok(output.includes('最后一条错误：无法加载主类'));
  assert.ok(!output.includes('old entry 0:'));
});

test('game log history is limited while active game logs remain available', async (t) => {
  const root = await fixture(t);
  const active = await createGameLog(root, 'running', {}, { maxFiles: 2 });
  for (let index = 0; index < 4; index += 1) {
    const log = await createGameLog(root, `ended-${index}`, {}, { maxFiles: 2 });
    await log.close('Exit 0');
  }
  const directory = path.dirname(active.filePath);
  assert.equal((await fs.readdir(directory)).length, 2);
  await fs.access(active.filePath);
  await active.close('Exit 0');
  assert.equal((await fs.readdir(directory)).length, 2);
});

async function writeLaunchProfile(root) {
  const directory = path.join(root, 'versions', 'base');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'base.jar'), 'fixture');
  await fs.writeFile(path.join(directory, 'base.json'), JSON.stringify({
    id: 'base', mainClass: 'net.minecraft.client.main.Main', libraries: [],
    minecraftArguments: '--accessToken ${auth_access_token}'
  }));
}

const account = {
  type: 'microsoft', name: 'Steve', uuid: '5627dd98-e6be-3c21-b8a8-e92344183641',
  accessToken: 'launch-secret'
};

test('launcher captures Java stdout and stderr and reports a flushed diagnostic log on exit', async (t) => {
  const root = await fixture(t);
  await writeLaunchProfile(root);
  let child;
  const launcher = new MinecraftLauncher({
    gameDirectory: root, findJava: async () => 'java-test',
    spawnProcess: (_java, args, options) => {
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.ok(args.includes('launch-secret'));
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.pid = 123;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });
  let exited;
  const completion = new Promise((resolve) => { exited = resolve; });
  const result = await launcher.launch({ profileId: 'base', account }, (status) => {
    if (status.phase === 'exited') exited(status);
  });
  child.stdout.write('Launch token launch-secret\n');
  child.stderr.write('Could not find or load main class\n');
  child.exitCode = 1;
  child.emit('close', 1, null);
  const status = await completion;
  assert.equal(status.logPath, result.logPath);
  assert.equal(status.code, 1);
  assert.equal(launcher.activeGames.size, 0);
  const output = await fs.readFile(status.logPath, 'utf8');
  assert.ok(output.includes('Could not find or load main class'));
  assert.ok(!output.includes('launch-secret'));
  assert.ok(output.includes('Exited with code 1'));
});

test('Java spawn failure includes a sanitized diagnostic log path and cleans launch natives', async (t) => {
  const root = await fixture(t);
  await writeLaunchProfile(root);
  const launcher = new MinecraftLauncher({
    gameDirectory: root, findJava: async () => 'missing-java',
    spawnProcess: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('error', new Error('spawn failed accessToken=launch-secret')));
      return child;
    }
  });
  let launchError;
  await assert.rejects(launcher.launch({ profileId: 'base', account }), (error) => {
    launchError = error;
    return error.message.includes('游戏日志：') && !error.message.includes('launch-secret');
  });
  const logPath = launchError.message.split('游戏日志：')[1];
  const output = await fs.readFile(logPath, 'utf8');
  assert.ok(output.includes('Unable to start Java'));
  assert.ok(!output.includes('launch-secret'));
  assert.deepEqual(await fs.readdir(path.join(root, 'launcher-cache', 'natives')), []);
});

test('an unavailable log directory does not prevent launch or leave Java output undrained', async (t) => {
  const root = await fixture(t);
  await writeLaunchProfile(root);
  await fs.mkdir(path.join(root, 'launcher-cache'));
  await fs.writeFile(path.join(root, 'launcher-cache', 'game-logs'), 'blocked directory');
  let child;
  const launcher = new MinecraftLauncher({
    gameDirectory: root, findJava: async () => 'java-test',
    spawnProcess: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }
  });
  let exited;
  const completion = new Promise((resolve) => { exited = resolve; });
  const result = await launcher.launch({ profileId: 'base', account }, (status) => {
    if (status.phase === 'exited') exited(status);
  });
  assert.equal(result.logPath, undefined);
  assert.ok(result.logError);
  assert.equal(child.stdout.listenerCount('data'), 1);
  assert.equal(child.stderr.listenerCount('data'), 1);
  child.stderr.write('No log directory, but game is running\n');
  child.exitCode = 0;
  child.emit('close', 0, null);
  const status = await completion;
  assert.equal(status.code, 0);
  assert.equal(status.logError, result.logError);
  assert.equal(launcher.activeGames.size, 0);
});
