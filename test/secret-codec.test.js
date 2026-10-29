const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSecretCodec } = require('../src/main/accounts/secret-codec');
const { AccountStore } = require('../src/main/accounts/account-store');

function storage(backend = 'gnome_libsecret') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString()
  };
}

for (const backend of ['basic_text', 'unknown', undefined]) {
  test(`Linux refuses unprotected backend ${backend} for both reads and writes`, () => {
    const safeStorage = storage(backend);
    if (backend === undefined) delete safeStorage.getSelectedStorageBackend;
    const codec = createSecretCodec(safeStorage, 'linux');
    assert.throws(() => codec.encode('token'), /密钥后端/);
    assert.throws(() => codec.decode('safe-storage:v1:dG9rZW4='), /密钥后端/);
  });
}

for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
  test(`Linux accepts protected backend ${backend}`, () => {
    const codec = createSecretCodec(storage(backend), 'linux');
    assert.equal(codec.decode(codec.encode('token')), 'token');
  });
}

test('native Windows/macOS storage does not depend on Linux backend reporting', () => {
  for (const platform of ['win32', 'darwin']) {
    const safeStorage = storage();
    delete safeStorage.getSelectedStorageBackend;
    const codec = createSecretCodec(safeStorage, platform);
    assert.equal(codec.decode(codec.encode('token')), 'token');
  }
});

test('unavailable encryption and legacy plaintext are rejected', () => {
  const codec = createSecretCodec({ isEncryptionAvailable: () => false }, 'linux');
  assert.throws(() => codec.encode('token'), /不可用/);
  assert.throws(() => codec.decode('safe-storage:v1:dG9rZW4='), /不可用/);
  assert.throws(() => codec.decode('token'), /未加密/);
});

test('Linux basic_text refuses login persistence and keeps offline accounts usable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-linux-secrets-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'accounts.json');
  const store = new AccountStore(file, { secretCodec: createSecretCodec(storage('basic_text'), 'linux') });
  await store.addOffline('Steve');
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(store.upsertYggdrasil({
    uuid: '01234567-89ab-cdef-0123-456789abcdef', name: 'Player_01',
    accessToken: 'access-secret', clientToken: 'client-secret'
  }), /密钥后端/);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal((await store.getCurrentAccount()).name, 'Steve');
  await store.addOffline('Alex');
  assert.equal((await store.getState()).accounts.length, 2);
});
