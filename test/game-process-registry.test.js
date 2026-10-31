const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { GameProcessRegistry } = require('../src/main/minecraft/game-process-registry');
const { MinecraftLauncher } = require('../src/main/minecraft/launch-core');

test('game registries retain the same map for equivalent directory paths', () => {
  const registry = new GameProcessRegistry();
  const root = path.resolve('registry-fixture');
  assert.equal(registry.forDirectory(root), registry.forDirectory(path.join(root, 'child', '..')));
  if (process.platform === 'win32') {
    assert.equal(registry.forDirectory(root), registry.forDirectory(root.toUpperCase()));
  }
});

test('preparing and running processes remain busy independently in each game directory', () => {
  const registry = new GameProcessRegistry();
  const local = path.resolve('local-game');
  const system = path.resolve('system-game');
  registry.forDirectory(local).set('same-version', { exitCode: null, preparing: true });
  assert.equal(registry.isBusy(local), true);
  assert.equal(registry.isBusy(system), false);
  registry.forDirectory(system).set('same-version', { exitCode: null, pid: 7 });
  registry.forDirectory(local).delete('same-version');
  assert.equal(registry.isBusy(local), false);
  assert.equal(registry.isBusy(system), true);
  registry.forDirectory(system).get('same-version').exitCode = 0;
  assert.equal(registry.isBusy(system), false);
});

test('new launcher services reuse injected process ownership and reject an existing launch', async () => {
  const registry = new GameProcessRegistry();
  const gameDirectory = path.resolve('existing-game');
  const activeGames = registry.forDirectory(gameDirectory);
  activeGames.set('fixture', { exitCode: null });
  const first = new MinecraftLauncher({ gameDirectory, activeGames, javaRuntime: {} });
  const reconstructed = new MinecraftLauncher({ gameDirectory, activeGames, javaRuntime: {} });
  assert.equal(first.activeGames, activeGames);
  assert.equal(reconstructed.activeGames, activeGames);
  await assert.rejects(reconstructed.launch({ profileId: 'fixture' }), /已经在运行/);
});
