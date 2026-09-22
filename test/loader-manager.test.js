const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MinecraftLoaderManager, loaderProfileCandidates } = require('../src/main/minecraft/loader-manager');
const { ManagedJavaRuntime } = require('../src/main/minecraft/managed-java-runtime');
const { findJavaExecutable } = require('../src/main/minecraft/java-runtime');
const { MinecraftSourceManager } = require('../src/main/minecraft/source-manager');

for (const preference of ['auto', 'official']) {
  test(`loader metadata body remains covered by timeout (${preference})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let bodyStarted;
    const started = new Promise((resolve) => { bodyStarted = resolve; });
    t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        bodyStarted();
      })
    }));
    const manager = new MinecraftLoaderManager({ gameDirectory: 'unused', sourceManager: { downloadPreference: preference } });
    const pending = manager.fetchMetadata([{ url: 'https://example.test/metadata', source: { id: 'official' } }], (response) => response.json());
    const rejected = assert.rejects(pending);
    await started;
    t.mock.timers.tick(10001);
    await rejected;
  });
}

test('loader version validation forwards cancellation to metadata fetching', async (t) => {
  const manager = new MinecraftLoaderManager({ gameDirectory: 'unused', sourceManager: new MinecraftSourceManager() });
  const controller = new AbortController();
  t.mock.method(manager, 'installedProfileIds', async () => new Set());
  t.mock.method(manager, 'fetchMetadata', async (_candidates, _parser, signal) => {
    assert.equal(signal, controller.signal);
    controller.abort();
    return { data: [{ loader: { version: '0.16.0', stable: true } }], source: { id: 'official' } };
  });
  await assert.rejects(manager.validateLoaderVersion('1.21.1', 'fabric', '0.16.0', controller.signal), { name: 'AbortError' });
  assert.equal(manager.cache.size, 0);
});

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

async function installerFixture(t, {
  loaderType = 'forge',
  javaVersion = 21,
  systemVersions = new Map(),
  managed = false
} = {}) {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-loader-java-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  const gameVersion = javaVersion === 8 ? '1.16.5' : '1.21.1';
  const loaderVersion = loaderType === 'forge'
    ? javaVersion === 8 ? '36.2.39' : '52.1.16'
    : '21.1.243';
  const profileId = loaderProfileCandidates(loaderType, gameVersion, loaderVersion)[0];
  const runtimeDownloads = [];
  const javaRuntime = new ManagedJavaRuntime({
    gameDirectory,
    findSystemJava: (explicitPath, requiredVersion) => findJavaExecutable(
      explicitPath,
      requiredVersion,
      async (candidate) => systemVersions.get(candidate),
      async (candidate) => [candidate, ...systemVersions.keys()]
    ),
    probeJava: async (candidate) => candidate === managedExecutable ? javaVersion : undefined,
    fetchRuntimeAssets: async (...args) => {
      runtimeDownloads.push(args);
      throw new Error('Unexpected runtime download');
    }
  });
  const managedExecutable = path.join(javaRuntime.runtimeRoot(javaVersion), 'bin', 'java.exe');
  if (managed) {
    await writeJson(path.join(javaRuntime.runtimeRoot(javaVersion), '.melody-runtime.json'), {
      schemaVersion: 1,
      majorVersion: javaVersion,
      executable: 'bin/java.exe'
    });
    await fs.mkdir(path.dirname(managedExecutable), { recursive: true });
    await fs.writeFile(managedExecutable, 'fixture managed runtime');
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('installer archive'));
  const installerExecutables = [];
  const manager = new MinecraftLoaderManager({
    gameDirectory,
    sourceManager: new MinecraftSourceManager(),
    javaRuntime,
    downloader: {
      installVersion: async () => {
        await writeJson(path.join(gameDirectory, 'versions', gameVersion, `${gameVersion}.json`), {
          id: gameVersion,
          ...(javaVersion === 8 ? {} : { javaVersion: { majorVersion: javaVersion } })
        });
        return { source: 'official' };
      }
    },
    runInstaller: async ({ javaExecutable }) => {
      installerExecutables.push(javaExecutable);
      await writeJson(path.join(gameDirectory, 'versions', profileId, `${profileId}.json`), {
        id: profileId,
        inheritsFrom: gameVersion
      });
    }
  });
  manager.validateLoaderVersion = async () => ({ entry: {}, source: { id: 'official' } });
  return {
    manager,
    request: { gameVersion, loaderType, loaderVersion },
    managedExecutable,
    installerExecutables,
    runtimeDownloads,
    profileId
  };
}

test('Forge installer chooses the Java major required by its base game', async (t) => {
  const fixture = await installerFixture(t, {
    systemVersions: new Map([['java-8', 8], ['java-21', 21]])
  });
  const result = await fixture.manager.installLoader(fixture.request);
  assert.equal(result.profileId, fixture.profileId);
  assert.deepEqual(fixture.installerExecutables, ['java-21']);
  assert.deepEqual(fixture.runtimeDownloads, []);
});

test('NeoForge installer can use an existing managed Java without a system installation', async (t) => {
  const fixture = await installerFixture(t, { loaderType: 'neoforge', managed: true });
  const result = await fixture.manager.installLoader(fixture.request);
  assert.equal(result.profileId, fixture.profileId);
  assert.deepEqual(fixture.installerExecutables, [fixture.managedExecutable]);
  assert.deepEqual(fixture.runtimeDownloads, []);
});

test('Legacy base metadata without javaVersion selects Java 8', async (t) => {
  const fixture = await installerFixture(t, {
    javaVersion: 8,
    systemVersions: new Map([['java-21', 21], ['java-8', 8]])
  });
  await fixture.manager.installLoader(fixture.request);
  assert.deepEqual(fixture.installerExecutables, ['java-8']);
});

test('Missing compatible Java stops the installer without downloading a runtime', async (t) => {
  const fixture = await installerFixture(t, { systemVersions: new Map([['java-8', 8]]) });
  await assert.rejects(fixture.manager.installLoader(fixture.request), /需要 Java 21/);
  assert.deepEqual(fixture.installerExecutables, []);
  assert.deepEqual(fixture.runtimeDownloads, []);
});
