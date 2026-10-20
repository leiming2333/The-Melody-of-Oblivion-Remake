const test = require('node:test');
const assert = require('node:assert/strict');

function element(tag = 'div') {
  const classes = new Set(), handlers = new Map();
  return { tagName: tag, children: [], attributes: {}, textContent: '', hidden: false, disabled: false, checked: false,
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(name, callback) { handlers.set(name, callback); },
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    focus() { this.focused = true; },
    querySelectorAll(selector) {
      const result = [];
      const walk = node => { for (const child of node.children ?? []) {
        if (selector === 'input:checked' && child.tagName === 'input' && child.checked) result.push(child);
        walk(child);
      } };
      walk(this); return result;
    }
  };
}

function useDocument(t) {
  const previous = globalThis.document;
  globalThis.document = { createElement: element };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
}

async function modpackFixture(t) {
  useDocument(t);
  const { createModpackUi } = await import('../src/renderer/modules/modpack-ui.mjs');
  const calls = [], progress = [], problems = [], state = {};
  const elements = Object.fromEntries(['recoveryPanel', 'resumeButton', 'discardButton', 'missingFiles', 'recoveryTitle']
    .map(name => [name, element()]));
  const file = { projectId: 1, fileId: 2, fileName: 'needed.jar', reason: 'restricted', canImport: true,
    officialUrl: 'https://www.curseforge.com/projects/1/files/2' };
  const waiting = { status: 'waiting-for-files', sessionId: 'recovery-session', name: 'Pack', files: [file] };
  let sequence = 0;
  const context = { state, elements, gameStatus: element(), statusBadge: element(), cancelDownloadButton: element(),
    downloadStatus: element(), readableError: error => error.message,
    updateVersionAction() {}, updateDownloadProgress: value => progress.push(value),
    newTaskId: () => `task-${++sequence}`, updateTaskEntry: value => calls.push(['entry', value]),
    showToast: (...args) => calls.push(['toast', ...args]), showProblem: (...args) => problems.push(args),
    openTask: () => calls.push(['open-task']), openExternal: async url => calls.push(['external', url]),
    confirmPack: async info => { calls.push(['confirm', info]); return { installOptionalFiles: true }; },
    loadLocalProfiles: async () => calls.push(['profiles']), useVersion: (...args) => calls.push(['selected', ...args]),
    minecraft: {
      inspectModpack: async () => ({ name: 'Pack', format: 'curseforge', fileCount: 2,
        requiredFileCount: 1, optionalFileCount: 1 }),
      installModpack: async (...args) => { calls.push(['install', ...args]); return waiting; },
      selectMissingModpackFile: async (...args) => { calls.push(['select', ...args]); return { ...waiting, files: [], canResume: true }; },
      resumeModpack: async (...args) => { calls.push(['resume', ...args]); return { status: 'complete', name: 'Pack', targetId: 'instance-pack' }; },
      discardModpackSession: async id => calls.push(['discard', id])
    } };
  return { ui: createModpackUi(context), context, state, elements, calls, progress, problems, waiting, file };
}

test('modpack recovery selects a required file by identity, preserves task IDs and resumes a complete instance', async t => {
  const f = await modpackFixture(t);
  await f.ui.install('C:/packs/pack.zip');
  assert.equal(f.elements.recoveryPanel.hidden, false);
  assert.equal(f.state.versionDownloadActive, false);
  assert.equal(f.context.statusBadge.textContent, 'WAITING');
  assert.equal(f.elements.missingFiles.children.length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'confirm').length, 1);
  const install = f.calls.find(call => call[0] === 'install');
  assert.equal(install[2].installOptionalFiles, true);
  assert.match(install[2].taskId, /^task-/);
  await f.ui.selectFile(f.file);
  const select = f.calls.find(call => call[0] === 'select');
  assert.equal(select[1], 'recovery-session');
  assert.deepEqual(select[2], { projectId: 1, fileId: 2 });
  assert.match(select[3].taskId, /^task-/);
  assert.equal(f.elements.missingFiles.children.length, 0);
  assert.equal(f.elements.recoveryPanel.hidden, false);
  await f.ui.resume();
  assert.equal(f.elements.recoveryPanel.hidden, true);
  assert.equal(f.context.statusBadge.textContent, 'SELECTED');
  assert.equal(f.state.modpackInstallActive, false);
  assert.equal(f.context.cancelDownloadButton.hidden, true);
  assert.deepEqual(f.calls.find(call => call[0] === 'selected'), ['selected', 'instance-pack', 'Pack']);
  assert.equal(f.problems.length, 0);
});

test('closing the native file chooser keeps the missing-file recovery available without a false error', async t => {
  const f = await modpackFixture(t);
  await f.ui.install('pack.zip');
  f.context.minecraft.selectMissingModpackFile = async () => ({ canceled: true });
  await f.ui.selectFile(f.file);
  assert.equal(f.elements.recoveryPanel.hidden, false);
  assert.equal(f.elements.missingFiles.children.length, 1);
  assert.equal(f.context.statusBadge.textContent, 'WAITING');
  assert.equal(f.state.versionDownloadActive, false);
  assert.equal(f.problems.length, 0);
  assert.equal(f.calls.some(call => call[0] === 'toast' && call[1] === '文件校验通过，可继续安装'), false);
});

test('expired manual-selection and resume sessions clear stale recovery controls and offer a fresh retry', async t => {
  const f = await modpackFixture(t);
  const expired = Object.assign(new Error('恢复会话已失效'), { code: 'MODPACK_SESSION_EXPIRED', retryable: false });
  await f.ui.install('pack.zip');
  f.context.minecraft.selectMissingModpackFile = async () => { throw expired; };
  await f.ui.selectFile(f.file);
  assert.equal(f.elements.recoveryPanel.hidden, true);
  assert.equal(f.context.statusBadge.textContent, 'ERROR');
  assert.equal(typeof f.problems.at(-1)[2].retry, 'function');
  await f.ui.install('pack.zip');
  f.context.minecraft.resumeModpack = async () => { throw expired; };
  await f.ui.resume();
  assert.equal(f.elements.recoveryPanel.hidden, true);
  assert.equal(f.state.versionDownloadActive, false);
});

test('a completed modpack result remains successful when a cancellation request arrived at the commit boundary', async t => {
  const f = await modpackFixture(t);
  f.context.minecraft.installModpack = async () => {
    f.state.downloadCancelRequested = true;
    return { status: 'complete', name: 'Pack', targetId: 'instance-pack' };
  };
  await f.ui.install('pack.zip');
  assert.equal(f.context.statusBadge.textContent, 'SELECTED');
  assert.match(f.context.gameStatus.textContent, /安装完成/);
  assert.equal(f.progress.at(-1).phase, 'complete');
  assert.equal(f.problems.length, 0);
});

test('one confirmation supplies the optional-file choice and declining it starts no installation', async t => {
  const f = await modpackFixture(t);
  let confirmations = 0;
  f.context.confirmPack = async info => { confirmations++; assert.equal(info.optionalFileCount, 1); return null; };
  await f.ui.install('pack.zip');
  assert.equal(confirmations, 1);
  assert.equal(f.calls.some(call => call[0] === 'install'), false);
  assert.equal(f.state.versionDownloadActive, false);
  assert.equal(f.state.modpackInstallActive, false);
  assert.equal(f.context.cancelDownloadButton.hidden, true);
});

test('changing the game directory clears waiting controls and requires selecting the archive again', async t => {
  const f = await modpackFixture(t);
  await f.ui.install('C:/pack.zip');
  assert.equal(f.elements.recoveryPanel.hidden, false);
  f.ui.directoryChanged();
  assert.equal(f.elements.recoveryPanel.hidden, true);
  assert.match(f.context.gameStatus.textContent, /重新选择整合包/);
  await f.ui.resume();
  await f.ui.retry();
  assert.equal(f.calls.some(call => call[0] === 'resume'), false);
  assert.equal(f.calls.filter(call => call[0] === 'install').length, 1);
});

async function updateFixture(t) {
  useDocument(t);
  const { createLauncherUpdateUi } = await import('../src/renderer/modules/launcher-update-ui.mjs');
  const names = ['launcherUpdateStatus', 'launcherVersionMeta', 'updateStatusBadge', 'updateStatusBadgeSvg',
    'updateBadgeRefresh', 'updateBadgeCheck', 'updateBadgeDownload', 'updateBadgeError', 'launcherUpdateProgress',
    'launcherUpdateButton', 'launcherUpdateNotesSetting', 'launcherUpdateNotes', 'launcherUpdateCancelButton',
    'launcherUpdateRecovery', 'launcherUpdateRecoveryMessage', 'launcherUpdateRetryButton', 'launcherUpdateRollbackButton',
    'launcherUpdateKeepButton', 'launcherHistorySetting', 'launcherHistoryButton', 'launcherHistoryList', 'launcherHistoryCleanupButton'];
  const elements = Object.fromEntries(names.map(name => [name, element()]));
  elements.settingsDialog = { querySelector: () => ({ scrollIntoView() {} }) };
  const calls = [], problems = [];
  const context = { elements, ensureSettingsOpen: async () => {}, renderProgressBar: (_element, value) => value ?? null,
    showToast: (...args) => calls.push(['toast', ...args]), showProblem: (...args) => problems.push(args),
    confirmRollback: async () => true,
    updaterApi: { cancel: async () => ({ status: 'available', availableVersion: '2.0', canCancel: false }),
      recover: async action => { calls.push(['recover', action]); return { status: 'preparing' }; },
      listHistory: async () => [{ id: 'one', name: 'old-one.exe', path: 'C:/launcher/old-one.exe', size: 123 },
        { id: 'two', name: '<script>old-two.exe</script>', path: 'C:/launcher/old-two.exe', size: 234 }],
      cleanupHistory: async ids => { calls.push(['cleanup', ids]); return { failed: [] }; } } };
  return { ui: createLauncherUpdateUi(context), context, elements, calls, problems };
}

test('update cancellation and recovery buttons reflect cancellable, committing and recovery states', async t => {
  const f = await updateFixture(t), e = f.elements;
  f.ui.render({ status: 'downloading', canCancel: true, progress: 40, platform: 'win32' });
  assert.equal(e.launcherUpdateButton.disabled, true);
  assert.equal(e.launcherUpdateCancelButton.hidden, false);
  await f.ui.cancel();
  assert.equal(e.launcherUpdateButton.disabled, false);
  assert.equal(e.launcherUpdateCancelButton.hidden, true);
  f.ui.render({ status: 'installing', canCancel: false });
  assert.equal(e.launcherUpdateCancelButton.hidden, true);
  f.ui.render({ status: 'error', recovery: { message: '安装未完成', actions: ['retry', 'keep-current'] } });
  assert.equal(e.launcherUpdateRecovery.hidden, false);
  assert.equal(e.launcherUpdateRetryButton.hidden, false);
  assert.equal(e.launcherUpdateKeepButton.hidden, false);
  assert.equal(e.launcherUpdateRollbackButton.hidden, true);
  assert.equal(e.launcherUpdateButton.disabled, true);
  await f.ui.recover('retry');
  assert.deepEqual(f.calls.find(call => call[0] === 'recover'), ['recover', 'retry']);
  assert.equal(e.launcherUpdateRetryButton.disabled, true);
  f.ui.render({ status: 'current', rollbackAvailable: true, rollbackVersion: '1.0' });
  f.context.confirmRollback = async () => false;
  await f.ui.recover('rollback');
  assert.equal(f.calls.filter(call => call[0] === 'recover').length, 1);
});

test('an update cancellation API failure restores its enabled cancel control', async t => {
  const f = await updateFixture(t);
  f.ui.render({ status: 'downloading', canCancel: true, progress: 40 });
  f.context.updaterApi.cancel = async () => { throw new Error('cancel failed'); };
  await f.ui.cancel();
  assert.equal(f.problems.length, 1);
  assert.equal(f.elements.launcherUpdateCancelButton.disabled, false);
});

test('the update badge opens recovery without starting another check or download', async t => {
  const f = await updateFixture(t);
  let checked = 0;
  f.context.updaterApi.check = async () => { checked++; return { status: 'available' }; };
  f.ui.render({ status: 'error', availableVersion: '2.0',
    recovery: { message: '需要恢复', actions: ['rollback', 'keep-current'] } });
  await f.ui.handleFromBadge();
  assert.equal(checked, 0);
  assert.equal(f.problems.length, 0);
  assert.equal(f.elements.launcherUpdateButton.focused, true);
});

test('history cleanup sends only checked opaque IDs and safely renders names before reloading', async t => {
  const f = await updateFixture(t);
  await f.ui.loadHistory();
  assert.equal(f.elements.launcherHistoryList.children.length, 2);
  await f.ui.cleanupHistory();
  assert.equal(f.calls.some(call => call[0] === 'cleanup'), false);
  const second = f.elements.launcherHistoryList.children[1].children[0];
  assert.equal(second.children[1].textContent, '<script>old-two.exe</script>');
  second.children[0].checked = true;
  f.context.updaterApi.listHistory = async () => [];
  await f.ui.cleanupHistory();
  assert.deepEqual(f.calls.find(call => call[0] === 'cleanup'), ['cleanup', ['two']]);
  assert.equal(f.elements.launcherHistoryCleanupButton.hidden, true);
  assert.equal(f.elements.launcherHistoryCleanupButton.disabled, false);
});
