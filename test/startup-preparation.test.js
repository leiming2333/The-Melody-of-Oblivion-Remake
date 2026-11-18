const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SettingsStore } = require('../src/main/settings/settings-store');
const { AccountStore } = require('../src/main/accounts/account-store');
const { createStartupPreparation, REQUIRED_STARTUP_RESOURCES, GAME_DIRECTORIES } = require('../src/main/startup-preparation');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-preparation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, '全新启动器 空格');
  const userData = path.join(root, 'user-data');
  const appData = path.join(root, 'app-data');
  for (const resource of REQUIRED_STARTUP_RESOURCES) {
    const filename = path.join(appRoot, resource);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, 'fixture resource');
  }
  const settings = new SettingsStore(path.join(userData, 'settings.json'));
  const accounts = new AccountStore(path.join(userData, 'accounts.json'));
  const app = { isPackaged: false, getAppPath: () => appRoot,
    getPath: (name) => ({ userData, appData, home: root }[name]) };
  const preparation = createStartupPreparation({ app, getSettingsStore: () => settings,
    getAccountStore: () => accounts, gameDirectoryOptions: { env: {} }, ...options });
  return { root, appRoot, userData, settings, accounts, preparation };
}

test('a fresh launch prepares complete configuration backups and game directories before reporting ready', async (t) => {
  const progress = [];
  const f = await fixture(t);
  const result = await f.preparation.prepare((state) => progress.push(state));
  assert.deepEqual(result, { ready: true, gameDirectory: path.join(f.appRoot, '.minecraft') });
  assert.deepEqual(progress.map((state) => state.phase), [
    'checking-resources', 'preparing-config', 'preparing-directories', 'ready'
  ]);
  assert.equal(progress.at(-1).progress, 100);
  for (const name of ['settings.json', 'accounts.json']) {
    const filename = path.join(f.userData, name);
    assert.deepEqual(JSON.parse(await fs.readFile(filename)), JSON.parse(await fs.readFile(`${filename}.bak`)));
  }
  assert.equal((await f.settings.getState()).memoryMb, 4096);
  assert.deepEqual((await f.accounts.getState()).accounts, []);
  for (const directory of GAME_DIRECTORIES) {
    assert.equal((await fs.stat(path.join(result.gameDirectory, directory))).isDirectory(), true);
  }
  assert.equal((await fs.stat(path.join(f.userData, 'logs'))).isDirectory(), true);
});

test('preparation preserves existing user configuration bytes and restores a missing primary from its backup', async (t) => {
  const f = await fixture(t);
  await f.settings.update({ memoryMb: 8192, gameDirectoryMode: 'system' });
  await f.accounts.addOffline('PreviousPlayer');
  const originalSettings = await fs.readFile(f.settings.filePath, 'utf8');
  const originalAccounts = await fs.readFile(f.accounts.filePath, 'utf8');
  const result = await f.preparation.prepare();
  assert.equal(result.gameDirectory, process.platform === 'darwin'
    ? path.join(f.root, 'Library', 'Application Support', 'minecraft')
    : process.platform === 'win32' ? path.join(f.root, 'app-data', '.minecraft') : path.join(f.root, '.minecraft'));
  await f.preparation.prepare();
  assert.equal(await fs.readFile(f.settings.filePath, 'utf8'), originalSettings);
  assert.equal(await fs.readFile(f.accounts.filePath, 'utf8'), originalAccounts);
  await fs.rm(`${f.accounts.filePath}.bak`);
  await f.preparation.prepare();
  assert.equal(await fs.readFile(`${f.accounts.filePath}.bak`, 'utf8'), originalAccounts);
  assert.equal(await fs.readFile(f.accounts.filePath, 'utf8'), originalAccounts);
  await fs.rm(f.settings.filePath);
  await f.preparation.prepare();
  assert.equal(await fs.readFile(f.settings.filePath, 'utf8'), originalSettings);
  assert.equal((await f.accounts.getState()).current.name, 'PreviousPlayer');
});

test('later launches recreate missing configuration and directories instead of trusting an earlier ready state', async (t) => {
  const f = await fixture(t);
  const { gameDirectory } = await f.preparation.prepare();
  await fs.rm(path.join(gameDirectory, 'assets'), { recursive: true });
  await fs.rm(f.accounts.filePath);
  await fs.rm(`${f.accounts.filePath}.bak`);
  await f.preparation.prepare();
  assert.equal((await fs.stat(path.join(gameDirectory, 'assets', 'indexes'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(gameDirectory, 'assets', 'objects'))).isDirectory(), true);
  assert.deepEqual((await f.accounts.getState()).accounts, []);
  assert.deepEqual(JSON.parse(await fs.readFile(f.accounts.filePath)).accounts, []);
});

test('missing, empty or directory-shaped application files block readiness and can be retried after repair', async (t) => {
  const f = await fixture(t);
  const resource = 'src/renderer/modules/modpack-ui.mjs';
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

test('unrecoverable configuration damage blocks preparation without replacing user content', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.userData);
  const damage = '{"accounts":[{"name":"PreviousPlayer"}';
  await fs.writeFile(f.accounts.filePath, damage);
  await assert.rejects(f.preparation.prepare(), (error) => error.code === 'CONFIG_CORRUPT');
  assert.equal(await fs.readFile(f.accounts.filePath, 'utf8'), damage);
  assert.equal((await fs.readdir(f.userData)).some((name) => name.startsWith('accounts.json.corrupt-')), true);
  await fs.writeFile(`${f.accounts.filePath}.bak`, JSON.stringify({ version: 4, currentId: null, accounts: [] }));
  assert.equal((await f.preparation.prepare()).ready, true);
});

test('concurrent preparations share work, propagate directory failures and allow a subsequent retry', async (t) => {
  let failed = false;
  let resourceChecks = 0;
  const f = await fixture(t, { fileSystem: { ...fs,
    stat: async (...args) => { resourceChecks += 1; return fs.stat(...args); },
    mkdir: async (directory, options) => {
      if (!failed && path.basename(directory) === 'libraries') {
        failed = true;
        throw Object.assign(new Error('directory is read only'), { code: 'EACCES' });
      }
      return fs.mkdir(directory, options);
    }
  } });
  const firstProgress = [];
  const secondProgress = [];
  const first = f.preparation.prepare((value) => firstProgress.push(value));
  const second = f.preparation.prepare((value) => secondProgress.push(value));
  assert.equal(first, second);
  const failures = await Promise.allSettled([first, second]);
  assert.equal(failures.every((result) => result.status === 'rejected' && result.reason.code === 'EACCES'), true);
  assert.equal(resourceChecks, REQUIRED_STARTUP_RESOURCES.length);
  assert.deepEqual(firstProgress, secondProgress);
  assert.equal(firstProgress.some((value) => value.phase === 'ready'), false);
  assert.equal((await f.preparation.prepare()).ready, true);
  assert.equal(resourceChecks, REQUIRED_STARTUP_RESOURCES.length * 2);
});

test('unwritable local game directories identify the affected mode and can be retried with the system directory', async (t) => {
  for (const operation of ['mkdir', 'access']) {
    let localRoot;
    const f = await fixture(t, { fileSystem: { ...fs,
      [operation]: async (filename, ...args) => {
        if (localRoot && filename.startsWith(`${localRoot}${path.sep}`)) {
          throw Object.assign(new Error('local game directory is read only'), { code: 'EACCES' });
        }
        return fs[operation](filename, ...args);
      }
    } });
    localRoot = path.join(f.appRoot, '.minecraft');
    await assert.rejects(f.preparation.prepare(), (error) => {
      assert.equal(error.code, 'EACCES');
      assert.equal(error.phase, 'preparing-directories');
      assert.deepEqual(error.details, { gameDirectoryMode: 'local', gameDirectory: localRoot });
      return true;
    });
    await f.settings.update({ gameDirectoryMode: 'system' });
    const result = await f.preparation.prepare();
    assert.equal(result.ready, true);
    assert.notEqual(result.gameDirectory, localRoot);
    assert.equal((await f.settings.getState()).gameDirectoryMode, 'system');
  }
});

test('configuration and log permission errors cannot be mistaken for game directory failures', async (t) => {
  const configurationError = Object.assign(new Error('configuration is read only'), { code: 'EACCES' });
  const config = await fixture(t, { getSettingsStore: () => ({
    storage: { runExclusive: (callback) => callback() },
    read: async () => { throw configurationError; }
  }) });
  await assert.rejects(config.preparation.prepare(), (error) => {
    assert.equal(error, configurationError);
    assert.equal(error.phase, undefined);
    assert.equal(error.details, undefined);
    return true;
  });

  for (const operation of ['mkdir', 'access']) {
    const logs = await fixture(t, { fileSystem: { ...fs,
      [operation]: async (filename, ...args) => {
        if (path.basename(filename) === 'logs') {
          throw Object.assign(new Error('logs are read only'), { code: 'EACCES' });
        }
        return fs[operation](filename, ...args);
      }
    } });
    await assert.rejects(logs.preparation.prepare(), (error) => {
      assert.equal(error.code, 'EACCES');
      assert.equal(error.phase, undefined);
      assert.equal(error.details, undefined);
      return true;
    });
  }
});

test('the source tree includes every resource required during startup', async () => {
  const root = path.resolve(__dirname, '..');
  for (const resource of REQUIRED_STARTUP_RESOURCES) {
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
    assert.equal(REQUIRED_STARTUP_RESOURCES.includes(`src/renderer/${resource}`), true, resource);
  }
});
