const test = require('node:test');
const assert = require('node:assert/strict');
const { createModuleController } = require('../src/renderer/modules/module-controller');
const { createDownloadUi } = require('../src/renderer/modules/download-ui');

test('a failed UI module stays local and retries without resetting another module', () => {
  let fail = true, otherCalls = 0;
  const errors = [];
  const broken = createModuleController({ create: () => {
    if (fail) throw new Error('Catalog component missing');
    return { render: () => 'catalog ready' };
  }, onError: (error) => errors.push(error.message) });
  const other = createModuleController({ create: () => ({ render: () => ++otherCalls }) });
  assert.equal(broken.invoke('render'), undefined);
  assert.equal(broken.state, 'error');
  assert.equal(other.invoke('render'), 1);
  broken.invoke('render');
  assert.deepEqual(errors, ['Catalog component missing']);
  fail = false;
  assert.equal(broken.retry(), 'catalog ready');
  assert.equal(other.invoke('render'), 2);
  assert.equal(other.state, 'ready');
});

test('cancellation and supersession belong to one module request rather than all UI work', () => {
  const catalog = createModuleController(), download = createModuleController();
  const oldCatalog = catalog.beginRequest('versions');
  const loaderCatalog = catalog.beginRequest('loaders');
  const installation = download.beginRequest('install');
  const newCatalog = catalog.beginRequest('versions');
  assert.equal(oldCatalog.signal.aborted, true);
  assert.equal(oldCatalog.current(), false);
  assert.equal(newCatalog.current(), true);
  oldCatalog.finish();
  assert.equal(newCatalog.current(), true, 'an old completion cannot clear the replacement request');
  catalog.cancel('versions');
  assert.equal(newCatalog.signal.aborted, true);
  assert.equal(loaderCatalog.signal.aborted, false);
  assert.equal(installation.signal.aborted, false);
  catalog.dispose();
  assert.equal(loaderCatalog.signal.aborted, true);
  assert.equal(installation.current(), true);
});

test('asynchronous module errors keep their original details for the feature retry flow', async () => {
  const failure = Object.assign(new Error('Catalog unavailable'), { code: 'NETWORK_ERROR', retryable: true });
  const module = createModuleController({ create: () => ({ load: async () => { throw failure; } }) });
  await assert.rejects(module.invokeAsync('load'), (error) => error === failure);
  assert.equal(module.error, failure);
  assert.equal(module.state, 'error');
});

test('an error notification failure cannot escape the failed module', () => {
  const module = createModuleController({ create: () => { throw new Error('Feature unavailable'); },
    onError: () => { throw new Error('Toast unavailable'); } });
  assert.doesNotThrow(() => module.invoke('render'));
  assert.equal(module.error.message, 'Feature unavailable');
});

function downloadFixture() {
  const state = { activeTaskId: 'forge-install', versionDownloadActive: true, downloadCancellable: true,
    downloadCancelRequested: false, activeDownloadLabel: 'Forge', launcherSettings: { downloadConcurrency: 8 } };
  const elements = Object.fromEntries(['sourceHint', 'cancelDownloadButton', 'homeCancelDownloadButton', 'taskButton',
    'downloadStatus', 'downloadMessage', 'downloadStage', 'downloadProgress', 'downloadPercent', 'gameStatus',
    'statusBadge', 'downloadSpeed', 'downloadEta'].map((name) => [name, { hidden: true }]));
  const module = createModuleController({ create: () => createDownloadUi({ state, ...elements,
    renderProgressBar: (_element, completed, total, complete) => complete ? 100 : total > 0 ? Math.round(completed * 100 / total) : null }) });
  return { module, state, elements };
}

test('download progress belongs to its task and remains available while another UI module fails', () => {
  const f = downloadFixture();
  const catalog = createModuleController({ create: () => { throw new Error('Catalog failed'); } });
  catalog.invoke('render');
  f.module.invoke('updateDownloadProgress', [{ taskId: 'previous-install', message: 'Stale progress' }]);
  assert.equal(f.state.lastDownloadProgress, undefined);
  f.module.invoke('updateDownloadProgress', [{ taskId: 'forge-install', phase: 'installing-loader', message: 'Applying patches',
    completedFiles: 1, totalFiles: 2 }]);
  assert.equal(f.elements.downloadMessage.textContent, 'Applying patches');
  assert.equal(f.elements.downloadPercent.textContent, '50%');
  assert.equal(f.elements.taskButton.hidden, false);
  assert.equal(f.elements.homeCancelDownloadButton.hidden, false);
  assert.equal(f.elements.gameStatus.textContent, '正在安装 Forge');
  assert.equal(f.module.state, 'ready');
});

test('a download commit boundary and pending cancellation cannot be overwritten by ordinary progress', () => {
  const f = downloadFixture();
  f.module.invoke('updateDownloadProgress', [{ phase: 'committing-instance', cancellable: false, message: 'Saving instance' }]);
  assert.equal(f.state.downloadCancellable, false);
  assert.equal(f.elements.homeCancelDownloadButton.hidden, true);
  f.module.invoke('updateDownloadProgress', [{ phase: 'copying-overrides', cancellable: true }]);
  assert.equal(f.state.downloadCancellable, false);
  assert.equal(f.elements.cancelDownloadButton.disabled, true);
  f.state.downloadCancelRequested = true;
  f.elements.downloadMessage.textContent = 'Cancelling';
  f.module.invoke('updateDownloadProgress', [{ phase: 'downloading-loader', message: 'Late progress' }]);
  assert.equal(f.elements.downloadMessage.textContent, 'Cancelling');
});
