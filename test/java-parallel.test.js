const test = require('node:test');
const assert = require('node:assert/strict');
const { detectJava, findJavaExecutable, javaRuntimeDetails } = require('../src/main/minecraft/java-runtime');
const { ManagedJavaRuntime } = require('../src/main/minecraft/managed-java-runtime');
const { EventEmitter } = require('node:events');

test('a rejected Java candidate does not hide other valid runtimes', async () => {
  const started = [];
  const result = await detectJava(undefined, async (candidate) => {
    started.push(candidate);
    if (candidate === 'broken') throw new Error('probe failed');
    return candidate === 'java25' ? 25 : 8;
  }, async () => ['broken', 'java8', 'java25']);
  assert.deepEqual(started, ['broken', 'java8', 'java25']);
  assert.equal(result.path, 'java25');
});

test('system Java lookup can use a healthy candidate while earlier paths are stalled', async () => {
  const started = [];
  const signals = [];
  const progress = [];
  const selected = await findJavaExecutable(undefined, 21, (candidate, _timeout, { signal }) => {
    started.push(candidate);
    signals.push(signal);
    return candidate === 'healthy' ? 21 : new Promise(() => {});
  }, async () => ['stalled', 'healthy', 'other', 'fourth', 'unused'], { onProgress: (value) => progress.push(value) });
  assert.equal(selected, 'healthy');
  assert.equal(started.length, 4, 'no more than four Java processes can run at once');
  assert.ok(signals.every((signal) => signal.aborted), 'remaining probes are cancelled once a runtime is found');
  assert.ok(progress.some((value) => value.javaPath === 'healthy'));
});

test('a compatible explicitly selected Java keeps priority over other runtimes', async () => {
  const started = [];
  assert.equal(await findJavaExecutable('preferred', 21, async (candidate) => {
    started.push(candidate);
    return 21;
  }, async () => ['preferred', 'other']), 'preferred');
  assert.deepEqual(started, ['preferred']);
});

test('Java lookup cancellation interrupts discovery and stalled custom probes', async () => {
  for (const stage of ['discovering', 'probing']) {
    const controller = new AbortController();
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const pending = findJavaExecutable(undefined, 21, () => {
      entered();
      return new Promise(() => {});
    }, async () => {
      if (stage === 'discovering') {
        entered();
        return new Promise(() => {});
      }
      return ['stalled'];
    }, { signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;
  }
});

test('settings Java detection bounds process concurrency and still returns the highest version', async () => {
  let active = 0;
  let maximum = 0;
  const result = await detectJava(undefined, async (candidate) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return candidate;
  }, async () => [8, 16, 17, 21, 25, 8, 17, 21, 8]);
  assert.equal(result.majorVersion, 25);
  assert.equal(result.runtimes.length, 9);
  assert.equal(maximum, 4);
});

test('cancelling Java details stops its process immediately', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => { killed = true; child.emit('close', null); };
  const controller = new AbortController();
  const pending = javaRuntimeDetails('fixture-java', undefined, { signal: controller.signal, spawnProcess: () => child });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(killed, true);
});

test('managed Java resolution exposes progress and cancellation even with an unresponsive resolver', async () => {
  const controller = new AbortController();
  const statuses = [];
  const runtime = new ManagedJavaRuntime({ gameDirectory: '.', findSystemJava: (_path, _major, _probe, _discover, options) => {
    assert.equal(options.signal, controller.signal);
    options.onProgress({ message: '正在检测 fixture Java' });
    return new Promise(() => {});
  } });
  const pending = runtime.resolve(undefined, 21, (status) => statuses.push(status), controller.signal);
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.ok(statuses.some((status) => status.message === '正在检测 fixture Java'));
});
