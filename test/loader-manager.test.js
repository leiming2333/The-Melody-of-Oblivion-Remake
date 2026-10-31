const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MinecraftLoaderManager, loaderArtifact, loaderProfileCandidates } = require('../src/main/minecraft/loader-manager');
const { ensureLauncherProfiles, fetchTrustedInstallerChecksum } = require('../src/main/minecraft/installer-support');
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

test('NeoForge lists the correct Maven series for Minecraft 1.21 and newer version formats', async (t) => {
  const manager = new MinecraftLoaderManager({ gameDirectory: 'unused', sourceManager: new MinecraftSourceManager() });
  const artifactVersions = ['21.0.167', '21.0.165-beta', '21.1.243', '26.2.0.1-beta'];
  t.mock.method(manager, 'installedProfileIds', async () => new Set());
  t.mock.method(manager, 'fetchMetadata', async () => ({
    data: `<versions>${artifactVersions.map((version) => `<version>${version}</version>`).join('')}</versions>`,
    source: { id: 'official' }
  }));
  for (const [gameVersion, expected] of [
    ['1.21', ['21.0.167', '21.0.165-beta']],
    ['1.21.0', ['21.0.167', '21.0.165-beta']],
    ['1.21.1', ['21.1.243']],
    ['26.2', ['26.2.0.1-beta']]
  ]) {
    const result = await manager.listLoaderVersions(gameVersion, 'neoforge');
    assert.deepEqual(result.versions.map((entry) => entry.version), expected, gameVersion);
  }
});

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value));
}

async function installerFixture(t, {
  loaderType = 'forge',
  javaVersion = 21,
  systemVersions = new Map(),
  managed = false,
  gameVersion: requestedGameVersion,
  loaderVersion: requestedLoaderVersion
} = {}) {
  const gameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-loader-java-test-'));
  t.after(() => fs.rm(gameDirectory, { recursive: true, force: true }));
  const gameVersion = requestedGameVersion ?? (javaVersion === 8 ? '1.16.5' : '1.21.1');
  const loaderVersion = requestedLoaderVersion ?? (loaderType === 'forge'
    ? javaVersion === 8 ? '36.2.39' : '52.1.16'
    : '21.1.243');
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
  const installerContents = Buffer.from('installer archive');
  const fetchRequests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetchRequests.push(String(url));
    if (String(url).endsWith('.sha256')) return new Response(crypto.createHash('sha256').update(installerContents).digest('hex'));
    if (String(url).endsWith('.sha1')) return new Response(crypto.createHash('sha1').update(installerContents).digest('hex'));
    return new Response(installerContents);
  });
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
      // Forge Installer 2.2 refuses a fresh directory without either official
      // launcher profile file. Preserve this upstream contract in the fixture.
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(gameDirectory, 'launcher_profiles.json'), 'utf8')).profiles, {});
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
    profileId,
    gameDirectory,
    installerContents,
    fetchRequests,
    installerPath: path.join(gameDirectory, 'launcher-cache', 'installers', loaderType,
      loaderArtifact(loaderType, gameVersion, loaderVersion).artifactVersion,
      path.basename(loaderArtifact(loaderType, gameVersion, loaderVersion).path))
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

test('installer checksums come from official Maven and only a missing SHA-256 permits SHA-1 fallback', async (t) => {
  const officialUrl = loaderArtifact('forge', '1.21.1', '52.1.16').officialUrl;
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    assert.ok(signal);
    requested.push(String(url));
    return String(url).endsWith('.sha256') ? new Response('', { status: 404 }) : new Response(`${'A'.repeat(40)}\n`);
  });
  assert.deepEqual(await fetchTrustedInstallerChecksum(officialUrl), { algorithm: 'sha1', digest: 'a'.repeat(40) });
  assert.deepEqual(requested, [`${officialUrl}.sha256`, `${officialUrl}.sha1`]);
});

for (const [status, text, code] of [
  [503, 'upstream unavailable', 'NETWORK_ERROR'],
  [200, '<html>download page</html>', 'INSTALLER_CHECKSUM_INVALID']
]) {
  test(`installer checksum HTTP ${status} does not silently downgrade or run unverified code`, async (t) => {
    const fixture = await installerFixture(t, { systemVersions: new Map([['java-21', 21]]) });
    const requested = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      requested.push(String(url));
      return new Response(text, { status });
    });
    await assert.rejects(fixture.manager.installLoader(fixture.request), (error) => {
      assert.equal(error.code, code);
      assert.ok(error.details.logPath);
      return true;
    });
    assert.deepEqual(requested, [`${loaderArtifact('forge', '1.21.1', '52.1.16').officialUrl}.sha256`]);
    assert.deepEqual(fixture.installerExecutables, []);
  });
}

test('installer checksum timeouts and user cancellation remain distinct and cover response bodies', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const officialUrl = loaderArtifact('forge', '1.21.1', '52.1.16').officialUrl;
  let bodyStarted;
  let started = new Promise((resolve) => { bodyStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    ok: true, status: 200, headers: new Headers(),
    text: () => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      bodyStarted();
    })
  }));
  const timedOut = fetchTrustedInstallerChecksum(officialUrl);
  const timeoutRejected = assert.rejects(timedOut, { code: 'NETWORK_ERROR', retryable: true });
  await started;
  t.mock.timers.tick(10001);
  await timeoutRejected;
  const controller = new AbortController();
  started = new Promise((resolve) => { bodyStarted = resolve; });
  const cancelled = fetchTrustedInstallerChecksum(officialUrl, controller.signal);
  const cancelledRejected = assert.rejects(cancelled, { name: 'AbortError' });
  await started;
  controller.abort();
  await cancelledRejected;
});

test('installer digest metadata cannot redirect to a mirror', async (t) => {
  const officialUrl = loaderArtifact('neoforge', '1.21.1', '21.1.243').officialUrl;
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    return new Response('', { status: 302, headers: { location: 'https://mirror.test/installer.sha256' } });
  });
  await assert.rejects(fetchTrustedInstallerChecksum(officialUrl), { code: 'INSTALLER_CHECKSUM_INVALID' });
  assert.deepEqual(requested, [`${officialUrl}.sha256`]);
});

test('missing official checksums block execution even when a nonempty installer cache exists', async (t) => {
  const fixture = await installerFixture(t, { systemVersions: new Map([['java-21', 21]]) });
  await fs.mkdir(path.dirname(fixture.installerPath), { recursive: true });
  await fs.writeFile(fixture.installerPath, 'nonempty unverified cache');
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(fixture.manager.installLoader(fixture.request), { code: 'INSTALLER_CHECKSUM_UNAVAILABLE' });
  assert.deepEqual(fixture.installerExecutables, []);
});

test('corrupt installer caches are removed and valid mirror bytes are checked against official SHA-256', async (t) => {
  const fixture = await installerFixture(t, { systemVersions: new Map([['java-21', 21]]) });
  await fs.mkdir(path.dirname(fixture.installerPath), { recursive: true });
  await fs.writeFile(fixture.installerPath, 'damaged nonempty cache');
  const digest = crypto.createHash('sha256').update(fixture.installerContents).digest('hex');
  const requested = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    if (String(url).endsWith('.sha256')) return new Response(digest);
    return new Response(String(url).includes('bmclapi') ? 'corrupt mirror response' : fixture.installerContents);
  });
  const result = await fixture.manager.installLoader(fixture.request);
  assert.equal(result.profileId, fixture.profileId);
  assert.equal((await fs.readFile(fixture.installerPath)).toString(), fixture.installerContents.toString());
  assert.ok(requested[0].startsWith('https://maven.minecraftforge.net/'));
  assert.ok(requested.some((url) => url.startsWith('https://bmclapi2.bangbang93.com/')));
  assert.ok(requested.some((url) => url === loaderArtifact('forge', '1.21.1', '52.1.16').officialUrl));
  assert.match(await fs.readFile(result.logPath, 'utf8'), /Removed corrupt installer cache/);
});

test('an installer cache is reverified on reuse and immediately before Java executes it', async (t) => {
  const fixture = await installerFixture(t, { systemVersions: new Map([['java-21', 21]]) });
  await fs.mkdir(path.dirname(fixture.installerPath), { recursive: true });
  await fs.writeFile(fixture.installerPath, fixture.installerContents);
  const originalResolve = fixture.manager.javaRuntime.resolve.bind(fixture.manager.javaRuntime);
  fixture.manager.javaRuntime.resolve = async (...args) => {
    const result = await originalResolve(...args);
    await fs.writeFile(fixture.installerPath, 'modified while resolving Java');
    return result;
  };
  await assert.rejects(fixture.manager.installLoader(fixture.request), { code: 'CHECKSUM_MISMATCH' });
  assert.deepEqual(fixture.installerExecutables, []);
  await assert.rejects(fs.access(fixture.installerPath), { code: 'ENOENT' });
  assert.equal(fixture.fetchRequests.length, 1, 'only the official sidecar is fetched for a verified cache');
});

for (const name of ['launcher_profiles.json', 'launcher_profiles_microsoft_store.json']) {
  test(`Forge compatibility setup preserves existing ${name} byte for byte`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-existing-profiles-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const original = '{"profiles":{"personal":{"name":"已有配置"}},"settings":{"theme":"dark"}}\n';
    await fs.writeFile(path.join(root, name), original);
    await ensureLauncherProfiles(root);
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), original);
    if (name !== 'launcher_profiles.json') await assert.rejects(fs.access(path.join(root, 'launcher_profiles.json')), { code: 'ENOENT' });
  });
}

test('a fresh Chinese and space path gets a minimal Forge-compatible profile under concurrent preparation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), '旋律 profiles '));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await Promise.all(Array.from({ length: 8 }, () => ensureLauncherProfiles(root)));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'launcher_profiles.json'), 'utf8')),
    { profiles: {}, settings: {}, version: 3 });
});

test('installer output survives failure in a bounded redacted log with actionable error details', async (t) => {
  const fixture = await installerFixture(t, { systemVersions: new Map([['java-21', 21]]) });
  fixture.manager.runInstaller = async ({ onLog }) => {
    onLog('stdout', Buffer.from('first installer line\nsecond installer line\n'));
    onLog('stderr', Buffer.from('accessToken=private-token\nlast failure line\n'));
    throw Object.assign(new Error('installer fixture failure'), { exitCode: 7 });
  };
  await assert.rejects(fixture.manager.installLoader(fixture.request), asyncError => {
    assert.equal(asyncError.details.exitCode, 7);
    assert.match(asyncError.message, /安装日志/);
    return true;
  });
  const logNames = await fs.readdir(path.join(fixture.gameDirectory, 'launcher-cache', 'game-logs'));
  assert.equal(logNames.length, 1);
  const log = await fs.readFile(path.join(fixture.gameDirectory, 'launcher-cache', 'game-logs', logNames[0]), 'utf8');
  assert.match(log, /first installer line\n\[stdout\] second installer line/);
  assert.match(log, /last failure line/);
  assert.match(log, /Java: java-21/);
  assert.match(log, /accessToken=\[REDACTED\]/);
  assert.doesNotMatch(log, /private-token/);
});

test('NeoForge 1.20.1 uses its historical official Maven coordinates and real installer profile ID', async (t) => {
  const manager = new MinecraftLoaderManager({ gameDirectory: 'unused', sourceManager: new MinecraftSourceManager() });
  t.mock.method(manager, 'installedProfileIds', async () => new Set());
  t.mock.method(manager, 'fetchMetadata', async (candidates) => {
    assert.ok(candidates.every((candidate) => candidate.url.endsWith('/net/neoforged/forge/maven-metadata.xml')));
    return { data: '<versions><version>1.20.1-47.1.106</version><version>1.20.1-47.1.105</version><version>20.2.1-beta</version></versions>',
      source: { id: 'official' } };
  });
  const listed = await manager.listLoaderVersions('1.20.1', 'neoforge');
  assert.deepEqual(listed.versions.map(({ version, artifactVersion }) => ({ version, artifactVersion })), [
    { version: '47.1.106', artifactVersion: '1.20.1-47.1.106' },
    { version: '47.1.105', artifactVersion: '1.20.1-47.1.105' }
  ]);
  // Confirmed from the official 47.1.106 installer install_profile.json and
  // version.json, fetched and inspected without executing it on 2026-10-31.
  assert.deepEqual(loaderProfileCandidates('neoforge', '1.20.1', '47.1.106'), ['1.20.1-forge-47.1.106']);
  assert.equal(loaderArtifact('neoforge', '1.20.1', '47.1.106').officialUrl,
    'https://maven.neoforged.net/releases/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar');
  const fixture = await installerFixture(t, { loaderType: 'neoforge', gameVersion: '1.20.1', loaderVersion: '47.1.106',
    javaVersion: 17, systemVersions: new Map([['java-17', 17]]) });
  const result = await fixture.manager.installLoader(fixture.request);
  assert.equal(result.profileId, '1.20.1-forge-47.1.106');
  assert.deepEqual(fixture.installerExecutables, ['java-17']);
  assert.equal(fixture.fetchRequests[0], `${loaderArtifact('neoforge', '1.20.1', '47.1.106').officialUrl}.sha256`);
});
