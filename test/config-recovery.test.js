const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AccountStore } = require('../src/main/accounts/account-store');
const { SettingsStore } = require('../src/main/settings/settings-store');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-config-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('new stores use defaults, while corrupt JSON without a backup blocks ordinary changes', async (t) => {
  const root = await temporaryDirectory(t);
  const accountsFile = path.join(root, 'accounts.json');
  const settingsFile = path.join(root, 'settings.json');
  assert.equal((await new AccountStore(accountsFile).getState()).accounts.length, 0);
  assert.equal((await new SettingsStore(settingsFile).getState()).memoryMb, 4096);
  for (const [file, bytes, makeStore, change] of [
    [accountsFile, '{"accounts":[{"name":"PreviousPlayer"}', (file) => new AccountStore(file), (store) => store.addOffline('Steve')],
    [settingsFile, '{"memoryMb":8192,', (file) => new SettingsStore(file), (store) => store.update({ wallpaperIndex: 1 })]
  ]) {
    await fs.writeFile(file, bytes);
    const store = makeStore(file);
    await assert.rejects(store.getState(), (error) => error.code === 'CONFIG_CORRUPT' && /原文件已保留/.test(error.message));
    await assert.rejects(change(store), (error) => error.code === 'CONFIG_CORRUPT');
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    const copies = (await fs.readdir(root)).filter((name) => name.startsWith(`${path.basename(file)}.corrupt-`));
    assert.equal(copies.length, 1, 'repeated attempts reuse one preserved copy of identical damage');
    assert.equal(await fs.readFile(path.join(root, copies[0]), 'utf8'), bytes);
  }
});

test('null, arrays and invalid record containers are corruption instead of empty defaults', async (t) => {
  const root = await temporaryDirectory(t);
  for (const [name, Constructor, values] of [
    ['accounts', AccountStore, [null, [], {}, { version: 999, accounts: [] }, { accounts: {} }, { accounts: [null] }, { accounts: [{ type: 'offline', id: 'broken' }] }]],
    ['settings', SettingsStore, [null, [], { version: 999 }, { javaPath: [] }, { autoUpdate: {} }, { javaRuntimes: {} }, { javaRuntimes: [null] }]]
  ]) {
    for (let index = 0; index < values.length; index += 1) {
      const file = path.join(root, `${name}-${index}.json`);
      const bytes = JSON.stringify(values[index]);
      await fs.writeFile(file, bytes);
      await assert.rejects(new Constructor(file).getState(), (error) => error.code === 'CONFIG_CORRUPT');
      assert.equal(await fs.readFile(file, 'utf8'), bytes);
    }
  }
});

test('settings recover the previous valid backup, preserve damage and accept later changes', async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'settings.json');
  const store = new SettingsStore(file);
  const previous = await store.update({ gameDirectoryMode: 'system', memoryMb: 8192 });
  await store.update({ memoryMb: 12288 });
  const damage = '{"memoryMb":12288,';
  await fs.writeFile(file, damage);
  const recovered = await store.getState();
  assert.deepEqual(recovered, { ...previous, recovery: store.recovery });
  assert.equal(await fs.readFile(store.recovery.quarantinePath, 'utf8'), damage);
  assert.equal(store.recovery.backupPath, `${file}.bak`);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).gameDirectoryMode, 'system');
  assert.equal((await store.update({ wallpaperIndex: 1 })).memoryMb, 8192);
  assert.equal((await store.read()).recovery, undefined);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).recovery, undefined);
});

test('account recovery and backup preserve encoded secrets and restrict copied file permissions', async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'accounts.json');
  const secretCodec = {
    encode: (value) => `cipher:${Buffer.from(value).toString('base64')}`,
    decode: (value) => Buffer.from(value.slice('cipher:'.length), 'base64').toString()
  };
  const store = new AccountStore(file, { secretCodec });
  const microsoftId = (await store.upsertMicrosoft({
    uuid: '01234567-89ab-cdef-0123-456789abcdef', name: 'Player_01',
    accessToken: 'synthetic-access-secret', microsoftRefreshToken: 'synthetic-refresh-secret'
  })).currentId;
  const original = await fs.readFile(file, 'utf8');
  await store.addOffline('Steve');
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), original);
  await fs.writeFile(file, 'null');
  const recovered = await store.getState();
  assert.equal(recovered.currentId, microsoftId);
  assert.deepEqual(recovered.recovery, store.recovery);
  assert.equal((await store.read()).recovery, undefined);
  assert.equal((await store.getCurrentAccount()).accessToken, 'synthetic-access-secret');
  for (const savedFile of [file, `${file}.bak`, store.recovery.quarantinePath]) {
    const content = await fs.readFile(savedFile, 'utf8');
    assert.equal(content.includes('synthetic-access-secret'), false);
    assert.equal(content.includes('synthetic-refresh-secret'), false);
    if (process.platform !== 'win32') assert.equal((await fs.stat(savedFile)).mode & 0o077, 0);
  }
  await store.addOffline('Alex');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).recovery, undefined);
});

test('invalid backups never replace corrupt originals, and a missing primary restores a valid backup', async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'settings.json');
  await fs.writeFile(file, '{broken');
  await fs.writeFile(`${file}.bak`, 'null');
  await assert.rejects(new SettingsStore(file).update({ memoryMb: 8192 }), (error) => error.code === 'CONFIG_CORRUPT');
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), 'null');
  await fs.writeFile(`${file}.bak`, JSON.stringify({ gameDirectoryMode: 'system', memoryMb: 8192 }));
  await fs.rm(file);
  const recovered = await new SettingsStore(file).getState();
  assert.equal(recovered.memoryMb, 8192);
  assert.equal(recovered.gameDirectoryMode, 'system');
});

test('concurrent recovery and updates across account store instances preserve both additions', async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, 'accounts.json');
  await new AccountStore(file).addOffline('Original');
  await fs.writeFile(file, '{interrupted');
  const first = new AccountStore(file);
  const second = new AccountStore(file);
  await Promise.all([first.getState(), first.addOffline('Steve'), second.addOffline('Alex')]);
  assert.deepEqual((await second.getState()).accounts.map((account) => account.name).sort(), ['Alex', 'Original', 'Steve']);
});
