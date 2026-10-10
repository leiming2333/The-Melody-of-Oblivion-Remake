const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { ManagedJavaRuntime } = require('../src/main/minecraft/managed-java-runtime');
const { MinecraftLauncher } = require('../src/main/minecraft/launch-core');

test('launch selection probes saved paths instead of trusting stored major versions', async () => {
  const paths = [8, 17, 21].map((major) => path.resolve(`java-${major}`, 'bin', 'java.exe'));
  const missing = path.resolve('removed-java', 'java.exe');
  const versions = new Map(paths.map((entry, index) => [entry, [8, 17, 21][index]]));
  const probes = [];
  const runtime = new ManagedJavaRuntime({ gameDirectory: '.', probeJava: async (candidate) => {
    probes.push(candidate);
    if (candidate === missing) throw new Error('removed');
    return versions.get(candidate);
  }, findSystemJava: async () => { throw new Error('should use saved Java'); } });
  const saved = [{ path: missing, majorVersion: 8 }, ...paths.map((entry) => ({ path: entry, majorVersion: 25 }))];
  for (const major of [8, 17, 21]) {
    probes.length = 0;
    const statuses = [];
    assert.equal(await runtime.resolveForGame(paths[2], major, saved, (status) => statuses.push(status)), paths[[8, 17, 21].indexOf(major)]);
    assert.equal(new Set(probes).size, probes.length);
    assert.equal(statuses.at(-1).majorVersion, major);
  }
});

test('incompatible preference falls back to managed runtime, reports missing Java, and respects cancellation', async () => {
  const runtime = new ManagedJavaRuntime({ gameDirectory: '.', probeJava: async () => 25,
    findSystemJava: async () => { throw new Error('not found'); } });
  runtime.installedExecutable = async (major) => major === 17 ? 'managed-17' : undefined;
  assert.equal(await runtime.resolveForGame(path.resolve('java25'), 17), 'managed-17');
  await assert.rejects(runtime.resolveForGame(path.resolve('java25'), 21), /需要 Java 21.*设置/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.resolveForGame('', 17, [], () => {}, controller.signal), { name: 'AbortError' });
});

test('game launch selects Java from inherited profile metadata and passes saved runtimes to resolver', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'java-launch-selection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const major of [8, 17, 21]) {
    const parent = `base-${major}`;
    const child = `loader-${major}`;
    for (const id of [parent, child]) await fs.mkdir(path.join(root, 'versions', id), { recursive: true });
    await fs.writeFile(path.join(root, 'versions', parent, `${parent}.json`), JSON.stringify({
      id: parent, mainClass: 'net.minecraft.client.main.Main', libraries: [], javaVersion: { majorVersion: major },
      minecraftArguments: '--username ${auth_player_name}'
    }));
    await fs.writeFile(path.join(root, 'versions', parent, `${parent}.jar`), 'fixture');
    await fs.writeFile(path.join(root, 'versions', child, `${child}.json`), JSON.stringify({ id: child, inheritsFrom: parent }));
    const saved = [{ path: path.join(root, `java${major}`), majorVersion: major }];
    let spawned;
    const launcher = new MinecraftLauncher({ gameDirectory: root,
      javaRuntime: { resolveForGame: async (preferred, required, runtimes) => {
        assert.equal(preferred, 'preferred-java');
        assert.equal(required, major);
        assert.deepEqual(runtimes, saved);
        return saved[0].path;
      } },
      spawnProcess: (executable) => {
        spawned = executable;
        const process = new EventEmitter();
        process.exitCode = null;
        queueMicrotask(() => process.emit('spawn'));
        return process;
      }
    });
    const statuses = [];
    await launcher.launch({ profileId: child, javaPath: 'preferred-java', javaRuntimes: saved,
      account: { type: 'offline', name: 'Steve', uuid: '5627dd98-e6be-3c21-b8a8-e92344183641' }
    }, (status) => statuses.push(status));
    assert.equal(spawned, saved[0].path);
    assert.equal(statuses.find((status) => status.phase === 'launching').javaPath, spawned);
  }
});
