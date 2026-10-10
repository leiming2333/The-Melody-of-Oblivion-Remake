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

test('modpack inspection excludes a second drop and cancellation never installs optional packs', async (t) => {
  const { installDroppedModpack } = await import('../src/renderer/modules/modpack-ui.mjs');
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: () => false };
  t.after(() => { globalThis.window = previousWindow; });
  let inspected = 0, installed = 0, finish;
  const state = {};
  const context = { state, minecraft: {
    inspectModpack: () => { inspected++; return new Promise(resolve => { finish = resolve; }); },
    installModpack: () => { installed++; }
  }, loaderNames: {}, cancelDownloadButton: {}, downloadStatus: {}, gameStatus: {}, statusBadge: {},
  updateVersionAction() {}, showToast() {}, readableError: error => error.message };
  const pending = installDroppedModpack(context, 'a.mrpack');
  await installDroppedModpack(context, 'b.zip');
  assert.equal(inspected, 1);
  finish({ name: 'Pack', optionalFileCount: 1 });
  await pending;
  assert.equal(installed, 0);
  assert.equal(state.modpackInstallActive, false);
  assert.equal(state.versionDownloadActive, false);
});
