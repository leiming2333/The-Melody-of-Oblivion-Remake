const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/main/settings/settings-store');
const { AccountStore } = require('../src/main/accounts/account-store');
const { prepareStore } = require('../src/main/store-preparation');
const { createStartupPreparation, REQUIRED_STARTUP_RESOURCES,
  MODULE_STARTUP_RESOURCES } = require('../src/main/startup-preparation');
const startupResources = [...REQUIRED_STARTUP_RESOURCES, ...Object.values(MODULE_STARTUP_RESOURCES).flat()];

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-preparation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, '全新启动器 空格');
  const userData = path.join(root, 'user-data');
  const appData = path.join(root, 'app-data');
  for (const resource of startupResources) {
    const filename = path.join(appRoot, resource);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, 'fixture resource');
  }
  const settings = new SettingsStore(path.join(userData, 'settings.json'));
  const accounts = new AccountStore(path.join(userData, 'accounts.json'));
  const app = { isPackaged: false, getAppPath: () => appRoot,
    getPath: (name) => ({ userData, appData, home: root }[name]) };
  const preparation = createStartupPreparation({ app, ...options });
  return { root, appRoot, userData, app, settings, accounts, preparation };
}

test('a fresh launch validates static resources without preparing configuration, game or log directories', async (t) => {
  const progress = [];
  const f = await fixture(t);
  const result = await f.preparation.prepare((state) => progress.push(state));
  assert.deepEqual(result, { ready: true });
  assert.deepEqual(progress.map((state) => state.phase), ['checking-resources', 'ready']);
  assert.equal(progress.at(-1).progress, 100);
  await assert.rejects(fs.access(f.userData), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.appRoot, '.minecraft')), { code: 'ENOENT' });
});

test('startup completes independently of never-settling settings and account modules', { timeout: 2000 }, async (t) => {
  const calls = [];
  const neverSettles = () => new Promise(() => {});
  const f = await fixture(t, {
    getSettingsStore: () => { calls.push('settings'); return neverSettles(); },
    getAccountStore: () => { calls.push('account'); return neverSettles(); }
  });
  assert.deepEqual(await f.preparation.prepare(), { ready: true });
  assert.deepEqual(calls, []);
  await assert.rejects(fs.access(f.userData), { code: 'ENOENT' });
});

test('startup needs no user paths or directory writes', async (t) => {
  const f = await fixture(t, { fileSystem: {
    stat: fs.stat,
    access: fs.access,
    mkdir: () => { throw new Error('Startup must not create directories'); }
  } });
  f.app.getPath = () => { throw new Error('Startup must not resolve module paths'); };
  assert.deepEqual(await f.preparation.prepare(), { ready: true });
});

test('individual stores prepare defaults and matching configuration backups when their modules start', async (t) => {
  const f = await fixture(t);
  for (const store of [f.settings, f.accounts]) {
    await prepareStore(store);
    assert.deepEqual(await fs.readFile(store.filePath), await fs.readFile(`${store.filePath}.bak`));
  }
  assert.equal((await f.settings.getState()).memoryMb, 4096);
  assert.deepEqual((await f.accounts.getState()).accounts, []);
});

test('individual store preparation preserves configuration bytes and restores missing primary files', async (t) => {
  const f = await fixture(t);
  await f.settings.update({ memoryMb: 8192, gameDirectoryMode: 'system' });
  await f.accounts.addOffline('PreviousPlayer');
  for (const store of [f.settings, f.accounts]) {
    const original = await fs.readFile(store.filePath);
    await fs.rm(`${store.filePath}.bak`, { force: true });
    await prepareStore(store);
    await prepareStore(store);
    assert.deepEqual(await fs.readFile(store.filePath), original);
    assert.deepEqual(await fs.readFile(`${store.filePath}.bak`), original);
    await fs.rm(store.filePath);
    await prepareStore(store);
    assert.deepEqual(await fs.readFile(store.filePath), original);
  }
  assert.equal((await f.settings.getState()).memoryMb, 8192);
  assert.equal((await f.accounts.getState()).current.name, 'PreviousPlayer');
});

test('individual store preparation preserves corrupt files and recovers from a subsequently supplied backup', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.userData);
  for (const [store, damage, backup] of [
    [f.settings, '{"gameDirectoryMode":"local"', { gameDirectoryMode: 'system', memoryMb: 8192 }],
    [f.accounts, '{"accounts":[{"name":"PreviousPlayer"}', { version: 4, currentId: null, accounts: [] }]
  ]) {
    await fs.writeFile(store.filePath, damage);
    await assert.rejects(prepareStore(store), { code: 'CONFIG_CORRUPT' });
    assert.equal(await fs.readFile(store.filePath, 'utf8'), damage);
    assert.equal((await fs.readdir(f.userData)).some((name) => name.startsWith(`${path.basename(store.filePath)}.corrupt-`)), true);
    await fs.writeFile(`${store.filePath}.bak`, JSON.stringify(backup));
    await prepareStore(store);
  }
  assert.equal((await f.settings.getState()).gameDirectoryMode, 'system');
  assert.equal((await f.settings.getState()).memoryMb, 8192);
  assert.deepEqual((await f.accounts.getState()).accounts, []);
  assert.deepEqual(await f.preparation.prepare(), { ready: true });
});

test('missing, empty or directory-shaped core files block readiness and can be retried after repair', async (t) => {
  const f = await fixture(t);
  const resource = 'src/renderer/renderer.js';
  const filename = path.join(f.appRoot, resource);
  await fs.rm(filename);
  for (const state of ['missing', 'empty', 'directory']) {
    if (state === 'empty') await fs.writeFile(filename, '');
    if (state === 'directory') { await fs.rm(filename); await fs.mkdir(filename); }
    const progress = [];
    await assert.rejects(f.preparation.prepare((value) => progress.push(value)),
      (error) => error.code === 'STARTUP_RESOURCE_MISSING' && error.resource === resource);
    assert.equal(progress.some((value) => value.phase === 'ready'), false);
    await assert.rejects(fs.access(f.userData), (error) => error.code === 'ENOENT');
  }
  await fs.rmdir(filename);
  await fs.writeFile(filename, 'restored module');
  assert.equal((await f.preparation.prepare()).ready, true);
});

test('optional module and appearance failures are reported without blocking unrelated modules', async (t) => {
  const f = await fixture(t);
  for (const [module, resources] of Object.entries(MODULE_STARTUP_RESOURCES)) {
    const resource = resources[0];
    const filename = path.join(f.appRoot, resource);
    await fs.rm(filename);
    for (const state of ['missing', 'empty', 'directory']) {
      if (state === 'empty') await fs.writeFile(filename, '');
      if (state === 'directory') { await fs.rm(filename); await fs.mkdir(filename); }
      const progress = [];
      const result = await f.preparation.prepare((value) => progress.push(value));
      assert.equal(result.ready, true);
      assert.equal(result.moduleErrors.length, 1);
      assert.equal(result.moduleErrors[0].module, module);
      assert.equal(result.moduleErrors[0].code, 'STARTUP_RESOURCE_MISSING');
      assert.equal(result.moduleErrors[0].resource, resource);
      assert.equal(progress.at(-1).phase, 'ready');
    }
    await fs.rmdir(filename);
    await fs.writeFile(filename, 'restored module');
    assert.equal((await f.preparation.prepare()).moduleErrors, undefined);
  }
});

test('concurrent preparations share one resource scan and progress, then recheck on later starts', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let resourceChecks = 0;
  const f = await fixture(t, { fileSystem: { ...fs,
    stat: async (...args) => {
      resourceChecks += 1;
      if (resourceChecks === 1) await gate;
      return fs.stat(...args);
    }
  } });
  const firstProgress = [];
  const secondProgress = [];
  const first = f.preparation.prepare((value) => firstProgress.push(value));
  await Promise.resolve();
  const second = f.preparation.prepare((value) => secondProgress.push(value));
  assert.equal(first, second);
  assert.deepEqual(secondProgress, firstProgress);
  release();
  assert.deepEqual(await Promise.all([first, second]), [{ ready: true }, { ready: true }]);
  assert.equal(resourceChecks, startupResources.length);
  assert.deepEqual(firstProgress, secondProgress);
  assert.equal(firstProgress.some((value) => value.phase === 'ready'), true);
  assert.equal((await f.preparation.prepare()).moduleErrors, undefined);
  assert.equal(resourceChecks, startupResources.length * 2);
});

test('concurrent core resource failures share rejection and allow a subsequent repair retry', async (t) => {
  const f = await fixture(t);
  const resource = REQUIRED_STARTUP_RESOURCES[0];
  const filename = path.join(f.appRoot, resource);
  await fs.rm(filename);
  const progress = [];
  const first = f.preparation.prepare((value) => progress.push(value));
  const second = f.preparation.prepare();
  assert.equal(first, second);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results.every((result) => result.status === 'rejected'
    && result.reason.code === 'STARTUP_RESOURCE_MISSING' && result.reason.resource === resource), true);
  assert.equal(results[0].reason, results[1].reason);
  assert.equal(progress.some((value) => value.phase === 'ready'), false);
  await fs.writeFile(filename, 'restored core resource');
  assert.deepEqual(await f.preparation.prepare(), { ready: true });
});

test('the source tree includes every resource required during startup', async () => {
  const root = path.resolve(__dirname, '..');
  for (const resource of startupResources) {
    const stat = await fs.stat(path.join(root, resource));
    assert.equal(stat.isFile() && stat.size > 0, true, resource);
  }
});

test('startup validation covers the local resources referenced by the home page, styles and lazy UI imports', async () => {
  const root = path.resolve(__dirname, '..');
  const html = await fs.readFile(path.join(root, 'src/renderer/index.html'), 'utf8');
  const renderer = await fs.readFile(path.join(root, 'src/renderer/renderer.js'), 'utf8');
  const styles = await fs.readFile(path.join(root, 'src/renderer/styles.css'), 'utf8');
  const referenced = [
    ...[...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]),
    ...[...renderer.matchAll(/import\('\.\/([^']+)'\)/g)].map((match) => match[1]),
    ...[...styles.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1])
  ];
  for (const resource of referenced.filter((value) => !/^(?:https?:|data:)/.test(value))) {
    assert.equal(startupResources.includes(`src/renderer/${resource}`), true, resource);
  }
});
