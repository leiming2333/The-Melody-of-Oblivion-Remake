const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { ModManager } = require('../src/main/minecraft/mod-manager');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-mods-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'sample.jar');
  await fs.writeFile(source, 'fixture mod');
  return { manager: new ModManager(), root, source, a: path.join(root, 'a'), b: path.join(root, 'b') };
}

test('import, disable and enable stay inside the chosen instance and never overwrite', async t => {
  const { manager, source, a, b } = await fixture(t);
  assert.deepEqual(await manager.importFile(a, source), [{ name: 'sample.jar', enabled: true }]);
  assert.deepEqual(await manager.list(b), []);
  await assert.rejects(manager.importFile(a, source), /未覆盖/);
  assert.deepEqual(await manager.setEnabled(a, 'sample.jar', false), [{ name: 'sample.jar.disabled', enabled: false }]);
  assert.equal(await fs.readFile(path.join(a, 'mods', 'sample.jar.disabled'), 'utf8'), 'fixture mod');
  await manager.setEnabled(a, 'sample.jar.disabled', true);
  assert.equal((await manager.list(a))[0].enabled, true);
  assert.throws(() => manager.setEnabled(a, '../escape.jar', false), /文件名无效/);
  assert.throws(() => manager.setEnabled(a, 'sample.jar', 'false'), /状态无效/);
});

test('conflicting enable keeps both files intact and queued changes are ordered', async t => {
  const { manager, source, a } = await fixture(t);
  await manager.importFile(a, source);
  await fs.writeFile(path.join(a, 'mods', 'sample.jar.disabled'), 'disabled original');
  await assert.rejects(manager.setEnabled(a, 'sample.jar.disabled', true), /同名/);
  assert.equal(await fs.readFile(path.join(a, 'mods', 'sample.jar.disabled'), 'utf8'), 'disabled original');
  await fs.unlink(path.join(a, 'mods', 'sample.jar.disabled'));
  await Promise.all([manager.setEnabled(a, 'sample.jar', false), manager.setEnabled(a, 'sample.jar.disabled', true)]);
  assert.deepEqual(await manager.list(a), [{ name: 'sample.jar', enabled: true }]);
  assert.equal(manager.queues.size, 0);
});

test('redirected Mod directories are rejected', async t => {
  const { manager, root, a } = await fixture(t);
  await fs.mkdir(a);
  await fs.symlink(root, path.join(a, 'mods'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.list(a), /不能是链接/);
});

test('Mod IPC imports into the selected profile and opens the same isolated directory', async t => {
  const { registerMinecraftIpc } = require('../src/main/minecraft/ipc');
  const { profileGameDirectory } = require('../src/main/minecraft/launch-target');
  const { root, source } = await fixture(t);
  const game = path.join(root, '.minecraft');
  const version = path.join(game, 'versions', '1.21');
  await fs.mkdir(version, { recursive: true });
  await fs.writeFile(path.join(version, '1.21.json'), JSON.stringify({ id: '1.21', mainClass: 'Main' }));
  const handlers = new Map();
  let opened;
  registerMinecraftIpc({ app: { getAppPath: () => root }, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: { openPath: async directory => { opened = directory; return ''; } },
    settingsStore: { getState: async () => ({ gameDirectoryMode: 'local', isolateProfiles: true }) },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [source] }) } });
  const result = await handlers.get('minecraft:import-mod')({ sender: {} }, '1.21');
  assert.equal(result.mods[0].name, 'sample.jar');
  await handlers.get('minecraft:open-directory')({}, '1.21');
  assert.equal(opened, profileGameDirectory(game, '1.21'));
  await assert.rejects(handlers.get('minecraft:list-mods')({}, '../escape'), /格式无效/);
});
