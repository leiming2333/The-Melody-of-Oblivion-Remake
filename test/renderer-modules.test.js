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

async function updateUiFixture() {
  const { createLauncherUpdateUi } = await import('../src/renderer/modules/launcher-update-ui.mjs');
  const node = () => ({
    classes: new Set(), attributes: {},
    classList: { toggle(name, enabled) { enabled ? this.owner.classes.add(name) : this.owner.classes.delete(name); } },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { this.focused = true; }
  });
  const elements = Object.fromEntries(['launcherUpdateStatus', 'launcherVersionMeta', 'updateStatusBadge',
    'updateStatusBadgeSvg', 'updateBadgeRefresh', 'updateBadgeCheck', 'updateBadgeDownload',
    'updateBadgeError', 'launcherUpdateProgress', 'launcherUpdateButton',
    'launcherUpdateNotesSetting', 'launcherUpdateNotes'].map(name => [name, node()]));
  for (const element of Object.values(elements)) element.classList.owner = element;
  const calls = [];
  elements.settingsDialog = { querySelector: () => ({ scrollIntoView: () => calls.push('scroll') }) };
  const context = {
    elements, ensureSettingsOpen: async () => calls.push('settings'),
    renderProgressBar: (element, completed) => completed ?? null,
    showToast: (...args) => calls.push(['toast', ...args]), showProblem: error => calls.push(error),
    updaterApi: {
      check: async () => { calls.push('check'); return { status: 'available', availableVersion: '2.0' }; },
      download: async () => { calls.push('download'); return { status: 'downloaded', installAction: 'open-folder' }; },
      install: async () => calls.push('install')
    }
  };
  return { ui: createLauncherUpdateUi(context), context, elements, calls };
}

test('update UI follows check, download, and install actions and opens settings first', async () => {
  const { ui, elements, calls } = await updateUiFixture();
  await ui.handleFromBadge();
  assert.deepEqual(calls, ['settings', 'scroll', 'check']);
  assert.equal(elements.launcherUpdateButton.focused, true);
  assert.equal(elements.launcherUpdateButton.textContent, '下载 2.0');
  assert.equal(elements.updateBadgeDownload.hidden, false);
  await ui.handle();
  assert.equal(elements.launcherUpdateButton.textContent, '打开下载位置');
  await ui.handle();
  assert.deepEqual(calls.slice(3), ['download', 'install']);
});

test('update UI renders release text safely and reports a failed download only once', async () => {
  const { ui, elements, calls, context } = await updateUiFixture();
  ui.render({ status: 'downloading', progress: 30, releaseNotes: '<script>alert(1)</script>' });
  assert.equal(elements.launcherUpdateNotes.textContent, '<script>alert(1)</script>');
  assert.equal(elements.launcherUpdateNotesSetting.hidden, false);
  assert.equal(elements.launcherUpdateButton.textContent, '30%');
  assert.equal(elements.launcherUpdateButton.disabled, true);
  ui.render({ status: 'verifying', progress: 100 });
  assert.equal(elements.launcherUpdateProgress.hidden, false);
  assert.equal(elements.launcherUpdateProgress.attributes.value, undefined);
  const failure = { status: 'error', message: 'checksum mismatch' };
  ui.render(failure);
  ui.render(failure);
  assert.deepEqual(calls, [['toast', '下载失败：checksum mismatch', true]]);
  assert.equal(elements.updateBadgeError.hidden, false);
  assert.equal(elements.launcherUpdateNotesSetting.hidden, true);
  const apiFailure = new Error('update server unavailable');
  context.updaterApi.check = async () => { throw apiFailure; };
  await ui.handle();
  assert.equal(calls.at(-1), apiFailure);
});
