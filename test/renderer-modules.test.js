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

async function accountUiFixture(t, rename) {
  const { renderAccountList } = await import('../src/renderer/modules/account-ui.mjs');
  const previousDocument = globalThis.document;
  const createElement = (tag) => ({
    tag, children: [], listeners: {}, classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    addEventListener(event, handler, options) {
      (this.listeners[event] ??= []).push({ handler, once: options?.once });
    },
    async dispatch(event, details = {}) {
      const listeners = [...(this.listeners[event] ?? [])];
      this.listeners[event] = listeners.filter((listener) => !listener.once);
      return Promise.all(listeners.map(({ handler }) => handler(details)));
    },
    blur() { return this.dispatch('blur'); }
  });
  globalThis.document = { createElement };
  t.after(() => { globalThis.document = previousDocument; });
  const account = { id: 'offline:steve', type: 'offline', name: 'Steve', uuid: 'offline-uuid', skinModel: 'steve' };
  const state = { accountState: { accounts: [account], currentId: account.id, current: account } };
  const calls = [], cards = [], toasts = [];
  const accountList = createElement('div');
  const context = {
    state, accountList, accountEmpty: {}, skinUrlForAccount: () => null,
    applySkinAvatar: (element, value) => { element.accountName = value.name; },
    accountsApi: {
      rename: async (id, name) => {
        calls.push(name);
        if (rename) return rename(id, name);
        if (name === 'Invalid') throw new Error('Invalid name');
        const renamed = { ...account, name };
        return { accounts: [renamed], currentId: id, current: renamed };
      }
    },
    updateAccountCard: () => cards.push(state.accountState.current?.name),
    showToast: (message) => toasts.push(message), readableError: (error) => error.message,
    selectAccount() {}, skinModelNames: {}, setAccountSkinModel() {}, removeAccount() {}
  };
  renderAccountList(context);
  const row = accountList.children[0];
  return { ...context, input: row.children[1].children[0], avatar: row.children[0], calls, cards, toasts, account };
}

test('offline names can be saved repeatedly and a failed rename restores the latest saved name', async (t) => {
  const { input, avatar, state, calls, cards, toasts } = await accountUiFixture(t);
  await input.blur();
  input.value = 'Alex';
  await input.blur();
  await input.blur();
  input.value = 'Player_02';
  await input.blur();
  input.value = 'Invalid';
  await input.blur();
  assert.deepEqual(calls, ['Alex', 'Player_02', 'Invalid']);
  assert.equal(input.value, 'Player_02');
  assert.equal(state.accountState.current.name, 'Player_02');
  assert.deepEqual(cards, ['Alex', 'Player_02']);
  assert.equal(avatar.accountName, 'Player_02');
  assert.equal(avatar.textContent, 'P');
  assert.equal(toasts.at(-1), 'Invalid name');
});

test('unknown saved account types cannot be selected while deletion remains available', async (t) => {
  const { renderAccountList } = await import('../src/renderer/modules/account-ui.mjs');
  const fixture = await accountUiFixture(t);
  const removed = [], selected = [];
  fixture.state.accountState.accounts = [{ id: 'unknown:legacy', type: 'unknown', name: 'Legacy', uuid: 'old-uuid' }];
  fixture.state.accountState.currentId = null;
  fixture.selectAccount = (id) => selected.push(id);
  fixture.removeAccount = (id) => removed.push(id);
  renderAccountList(fixture);
  const row = fixture.accountList.children[0];
  assert.equal(row.children[1].children[1].textContent, '不支持的账户类型');
  const [selectButton, removeButton] = row.children[2].children;
  assert.equal(selectButton.textContent, '不可用');
  assert.equal(selectButton.disabled, true);
  await selectButton.dispatch('click');
  assert.deepEqual(selected, []);
  await removeButton.dispatch('click');
  assert.deepEqual(removed, ['unknown:legacy']);
});

test('successive pending offline renames save in order without replacing later text or account selection', async (t) => {
  let entered, release;
  const requested = new Promise((resolve) => { entered = resolve; });
  const allowed = new Promise((resolve) => { release = resolve; });
  const fixture = await accountUiFixture(t, async (id, name) => {
    if (name === 'First') { entered(); await allowed; }
    return { accounts: [{ id, name }], currentId: id, current: { id, name } };
  });
  const { input, avatar, state, calls, cards, toasts } = fixture;
  input.value = 'First';
  const first = input.blur();
  await requested;
  input.value = 'Latest';
  const latest = input.blur();
  const duplicate = input.blur();
  const selected = { id: 'offline:other', type: 'offline', name: 'Other', uuid: 'other-uuid' };
  state.accountState.accounts.push(selected);
  state.accountState.currentId = selected.id;
  state.accountState.current = selected;
  release();
  await Promise.all([first, latest, duplicate]);
  assert.deepEqual(calls, ['First', 'Latest']);
  assert.equal(input.value, 'Latest');
  assert.equal(state.accountState.accounts[0].name, 'Latest');
  assert.equal(state.accountState.currentId, selected.id);
  assert.equal(state.accountState.current, selected);
  assert.deepEqual(cards, ['Other', 'Other']);
  assert.equal(avatar.accountName, 'Latest');
  assert.deepEqual(toasts, ['已改名：Latest']);
});

test('a pending rename failure preserves text typed after the save began', async (t) => {
  let entered, release;
  const requested = new Promise((resolve) => { entered = resolve; });
  const allowed = new Promise((resolve) => { release = resolve; });
  const { input, state, calls } = await accountUiFixture(t, async (id, name) => {
    if (name === 'Invalid') { entered(); await allowed; throw new Error('Invalid name'); }
    return { accounts: [{ id, name }] };
  });
  input.value = 'Invalid';
  const saving = input.blur();
  await requested;
  input.value = 'Newest';
  release();
  await saving;
  assert.equal(input.value, 'Newest');
  await input.blur();
  assert.equal(state.accountState.current.name, 'Newest');
  assert.deepEqual(calls, ['Invalid', 'Newest']);
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
  assert.equal(calls[0][0], 'pack.mrpack');
  assert.equal(calls[0][1].installOptionalFiles, false);
  assert.equal(typeof calls[0][1].taskId, 'string');
  assert.deepEqual(calls[1], ['instance-pack', 'Pack']);
  assert.equal(state.modpackInstallActive, false);
  assert.equal(context.cancelDownloadButton.hidden, true);
  context.minecraft.installModpack = async () => { throw new Error('network failed'); };
  await installDroppedModpack(context, 'pack.mrpack');
  assert.equal(state.versionDownloadActive, false);
  assert.equal(context.statusBadge.textContent, 'ERROR');
});

test('modpack UI restores a persisted missing-file session on startup', async () => {
  const { createModpackUi } = await import('../src/renderer/modules/modpack-ui.mjs');
  const state = { versionDownloadActive: false, modpackInstallActive: false };
  const recoveryPanel = { hidden: true };
  const recoveryTitle = { textContent: '' };
  const gameStatus = { textContent: '' };
  const statusBadge = { textContent: '' };
  const toasts = [];
  const ui = createModpackUi({ state, minecraft: { getModpackRecovery: async () => ({
    status: 'waiting-for-files', sessionId: 'persisted', name: 'Persisted Pack', sourceName: 'pack.zip',
    canResume: false, files: [{ projectId: 1, fileId: 2, reason: 'restricted', canImport: true }]
  }) }, cancelDownloadButton: {}, downloadStatus: {}, gameStatus, statusBadge,
  updateDownloadProgress() {}, updateVersionAction() {}, updateTaskEntry() {}, openTask() {},
  showToast: (message) => toasts.push(message), readableError: error => error.message,
  elements: { recoveryPanel, recoveryTitle } });
  const result = await ui.restore();
  assert.equal(result.sessionId, 'persisted');
  assert.equal(recoveryPanel.hidden, false);
  assert.equal(recoveryTitle.textContent, 'Persisted Pack · 1 个文件待处理');
  assert.equal(gameStatus.textContent, 'Persisted Pack 需要补齐文件');
  assert.equal(statusBadge.textContent, 'WAITING');
  assert.deepEqual(toasts, ['已恢复 Persisted Pack 的补齐会话']);
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
  updateDownloadProgress() {}, updateVersionAction() {}, showToast() {}, readableError: error => error.message };
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
  assert.deepEqual(calls[0], ['toast', '下载失败：checksum mismatch', true]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].message, 'checksum mismatch');
  assert.equal(elements.updateBadgeError.hidden, false);
  assert.equal(elements.launcherUpdateNotesSetting.hidden, true);
  const apiFailure = new Error('update server unavailable');
  context.updaterApi.check = async () => { throw apiFailure; };
  await ui.handle();
  assert.equal(calls.at(-1), apiFailure);
});
