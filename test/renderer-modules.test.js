const test = require('node:test');
const assert = require('node:assert/strict');

test('lazy account UI renders the current state without opening a dialog', async () => {
  const { renderAccountList } = await import('../src/renderer/modules/account-ui.mjs');
  const list = { replaceChildren() { this.cleared = true; } };
  const empty = {};
  renderAccountList({ state: { accountState: { accounts: [] } }, accountList: list, accountEmpty: empty });
  assert.equal(list.cleared, true);
  assert.equal(empty.hidden, false);
});

test('lazy modpack UI installs through existing IPC and resets state after success or failure', async (t) => {
  const { installDroppedModpack } = await import('../src/renderer/modules/modpack-ui.mjs');
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: () => true };
  t.after(() => { globalThis.window = previousWindow; });
  const calls = [];
  const state = { versionDownloadActive: false, modpackInstallActive: false };
  const context = { state, minecraft: {
    inspectModpack: async () => ({ format: 'modrinth', name: 'Pack', fileCount: 1 }),
    installModpack: async (...args) => { calls.push(args); return { name: 'Pack', targetId: 'instance-pack' }; }
  }, loaderNames: {}, cancelDownloadButton: {}, downloadStatus: {}, gameStatus: {}, statusBadge: {},
  updateDownloadProgress() {}, updateVersionAction() {}, loadLocalProfiles: async () => {},
  useVersion: (...args) => calls.push(args), showToast: (message) => calls.push(message),
  readableError: (error) => error.message };
  await installDroppedModpack(context, 'pack.mrpack');
  assert.deepEqual(calls[0], ['pack.mrpack', { installOptionalFiles: false }]);
  assert.deepEqual(calls[1], ['instance-pack', 'Pack']);
  assert.equal(state.modpackInstallActive, false);
  assert.equal(context.cancelDownloadButton.hidden, true);
  context.minecraft.installModpack = async () => { throw new Error('network failed'); };
  await installDroppedModpack(context, 'pack.mrpack');
  assert.equal(state.versionDownloadActive, false);
  assert.equal(context.statusBadge.textContent, 'ERROR');
});
