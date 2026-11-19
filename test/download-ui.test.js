const test = require('node:test');
const assert = require('node:assert/strict');
const { createDownloadUi } = require('../src/renderer/modules/download-ui');

function fixture() {
  const state = { activeTaskId: 'install-current', versionDownloadActive: true, downloadCancellable: true,
    downloadCancelRequested: false, activeDownloadLabel: 'Minecraft 1.21.1',
    launcherSettings: { downloadConcurrency: 8 } };
  const elements = Object.fromEntries(['sourceHint', 'cancelDownloadButton', 'homeCancelDownloadButton',
    'taskButton', 'downloadStatus', 'downloadMessage', 'downloadStage', 'downloadProgress',
    'downloadPercent', 'gameStatus', 'statusBadge', 'downloadSpeed', 'downloadEta', 'downloadSize', 'downloadFiles']
    .map(name => [name, { textContent: '', hidden: false, disabled: false }]));
  const ui = createDownloadUi({ state, ...elements,
    renderProgressBar: (_element, completed, total, complete) => complete ? 100
      : total > 0 ? Math.round(completed * 100 / total) : null });
  return { ui, state, elements };
}

test('download feedback shows transferred size, file count and an ETA that carries seconds into minutes', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ phase: 'downloading', completedBytes: 1048576, totalBytes: 4194304,
    completedFiles: 2, totalFiles: 8, bytesPerSecond: 1048576, etaSeconds: 119.2 });
  assert.equal(f.elements.downloadSize.textContent, '1.0 MB / 4.0 MB');
  assert.equal(f.elements.downloadFiles.textContent, '文件 2 / 8');
  assert.equal(f.elements.downloadSpeed.textContent, '1.0 MB/s');
  assert.equal(f.elements.downloadEta.textContent, '剩余 2 分 0 秒');
  assert.equal(f.elements.downloadPercent.textContent, '25%');
});

test('an unknown total uses file progress and never turns a null ETA into zero seconds', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ phase: 'downloading-files', completedBytes: 2097152,
    totalBytes: 4194304, totalBytesKnown: false, completedFiles: 4, totalFiles: 10,
    bytesPerSecond: 1048576, etaSeconds: null });
  assert.equal(f.elements.downloadSize.textContent, '已传输 2.0 MB');
  assert.equal(f.elements.downloadFiles.textContent, '文件 4 / 10');
  assert.equal(f.elements.downloadPercent.textContent, '40%');
  assert.equal(f.elements.downloadEta.textContent, '剩余时间计算中');
  f.ui.updateDownloadProgress({ phase: 'downloading-files', completedFiles: 3, totalFiles: 10 });
  assert.equal(f.elements.downloadSize.textContent, '已完成 3 / 10 个文件');
});

test('preparing, verifying and installing describe current work after network transfer stops', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ phase: 'downloading-loader', bytesPerSecond: 1048576, etaSeconds: 7 });
  f.ui.updateDownloadProgress({ phase: 'verifying-installer' });
  assert.equal(f.elements.downloadSpeed.textContent, '正在校验');
  assert.equal(f.elements.downloadEta.textContent, '剩余时间 —');
  assert.equal(f.elements.gameStatus.textContent, '正在校验 Minecraft 1.21.1');
  f.ui.updateDownloadProgress({ phase: 'installing-loader', completedFiles: 1, totalFiles: 2 });
  assert.equal(f.elements.downloadSpeed.textContent, '正在安装');
  assert.equal(f.elements.gameStatus.textContent, '正在安装 Minecraft 1.21.1');
  f.ui.updateDownloadProgress({ phase: 'preparing-loader' });
  assert.equal(f.elements.downloadSpeed.textContent, '正在读取依赖');
  assert.equal(f.elements.downloadPercent.textContent, '—');
});

test('network progress nested inside base installation still shows current transfer metrics', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ phase: 'installing-base', completedBytes: 1048576, totalBytes: 2097152,
    bytesPerSecond: 524288, etaSeconds: 2 });
  assert.equal(f.elements.downloadSpeed.textContent, '512 KB/s');
  assert.equal(f.elements.downloadEta.textContent, '剩余 2 秒');
});

test('waiting and terminal feedback clear speed and preserve the last measured counters', () => {
  for (const [phase, label] of [['complete', '已完成'], ['cancelled', '已取消'], ['failed', '等待重试'],
    ['waiting-for-files', '等待补齐文件']]) {
    const f = fixture();
    f.ui.updateDownloadProgress({ phase: 'downloading-files', completedBytes: 1048576,
      totalBytes: 4194304, completedFiles: 2, totalFiles: 8, bytesPerSecond: 1048576, etaSeconds: 3 });
    f.ui.updateDownloadProgress({ phase });
    assert.equal(f.elements.downloadSpeed.textContent, '速度 —');
    assert.equal(f.elements.downloadEta.textContent, label);
    if (phase === 'complete') {
      assert.equal(f.elements.downloadSize.textContent, '4.0 MB / 4.0 MB');
      assert.equal(f.elements.downloadFiles.textContent, '文件 8 / 8');
    } else {
      assert.equal(f.elements.downloadSize.textContent, '1.0 MB / 4.0 MB');
      assert.equal(f.elements.downloadFiles.textContent, '文件 2 / 8');
    }
  }
});

test('late task events and ordinary progress cannot replace pending cancellation or reopen cancellation after commit', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ taskId: 'old-task', phase: 'complete', sourceLabel: 'Old source' });
  assert.equal(f.state.lastDownloadProgress, undefined);
  assert.equal(f.elements.sourceHint.textContent, '');
  f.ui.updateDownloadProgress({ phase: 'committing-instance', cancellable: false });
  f.ui.updateDownloadProgress({ phase: 'downloading', cancellable: true });
  assert.equal(f.elements.cancelDownloadButton.disabled, true);
  assert.equal(f.elements.homeCancelDownloadButton.hidden, true);
  f.state.downloadCancelRequested = true;
  f.elements.downloadMessage.textContent = '正在取消下载';
  f.ui.updateDownloadProgress({ phase: 'downloading', message: 'Late packet' });
  assert.equal(f.elements.downloadMessage.textContent, '正在取消下载');
  f.ui.updateDownloadProgress({ phase: 'cancelled' });
  assert.equal(f.elements.downloadEta.textContent, '已取消');
});

test('a new task clears old terminal counters and absent optional metrics remain supported', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ phase: 'downloading', completedBytes: 1024, totalBytes: 2048 });
  f.ui.updateDownloadProgress({ phase: 'complete' });
  f.state.activeTaskId = 'next-task';
  f.ui.updateDownloadProgress({ phase: 'preparing' });
  assert.equal(f.elements.downloadSize.textContent, '大小 —');
  assert.equal(f.elements.downloadFiles.textContent, '文件数 —');
  const optional = fixture();
  const ui = createDownloadUi({ ...optional.elements, downloadSize: undefined, downloadFiles: undefined,
    state: optional.state, renderProgressBar: () => null });
  assert.doesNotThrow(() => ui.updateDownloadProgress({ phase: 'downloading', bytesPerSecond: NaN }));
});

test('backend and frontend waiting events retain the same measured counters when the task is reopened', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ taskId: f.state.activeTaskId, phase: 'downloading-files',
    completedBytes: 1048576, totalBytes: 4194304, totalBytesKnown: false,
    completedFiles: 2, totalFiles: 8, bytesPerSecond: 1048576, etaSeconds: 3, message: 'Downloading files' });
  f.ui.updateDownloadProgress({ taskId: f.state.activeTaskId, phase: 'waiting-for-files', message: 'Backend waiting' });
  f.ui.updateDownloadProgress({ taskId: f.state.activeTaskId, phase: 'waiting-for-files',
    message: '请补齐缺失文件，或重新查询后继续', cancellable: false });
  f.ui.updateDownloadProgress(f.state.lastDownloadProgress);
  assert.equal(f.elements.downloadSize.textContent, '已传输 1.0 MB');
  assert.equal(f.elements.downloadFiles.textContent, '文件 2 / 8');
  assert.equal(f.elements.downloadPercent.textContent, '25%');
  assert.equal(f.state.lastDownloadProgress.totalBytesKnown, false);
  assert.equal(f.state.lastDownloadProgress.bytesPerSecond, undefined);
  assert.equal(f.state.lastDownloadProgress.etaSeconds, undefined);
  assert.equal(f.elements.downloadMessage.textContent, '请补齐缺失文件，或重新查询后继续');
});

test('repeated terminal events preserve counters without inheriting old network messages or speed', () => {
  for (const phase of ['complete', 'failed', 'cancelled']) {
    const f = fixture();
    f.ui.updateDownloadProgress({ taskId: f.state.activeTaskId, phase: 'downloading',
      completedBytes: 1048576, totalBytes: 4194304, completedFiles: 2, totalFiles: 8,
      bytesPerSecond: 1048576, etaSeconds: 3, message: 'Old download message' });
    f.ui.updateDownloadProgress({ phase, message: 'First terminal message' });
    f.ui.updateDownloadProgress({ phase, message: 'Current terminal message' });
    assert.equal(f.elements.downloadFiles.textContent, phase === 'complete' ? '文件 8 / 8' : '文件 2 / 8');
    assert.equal(f.elements.downloadSize.textContent, phase === 'complete'
      ? '4.0 MB / 4.0 MB' : '1.0 MB / 4.0 MB');
    assert.equal(f.state.lastDownloadProgress.bytesPerSecond, undefined);
    assert.equal(f.state.lastDownloadProgress.etaSeconds, undefined);
    assert.equal(f.state.lastDownloadProgress.message, 'Current terminal message');
  }
});

test('ignored progress during cancellation cannot replace the cached counters or reappear on reopening', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ taskId: f.state.activeTaskId, phase: 'downloading-files',
    completedBytes: 1048576, totalBytes: 4194304, completedFiles: 2, totalFiles: 8, message: 'Last accepted event' });
  const cached = f.state.lastDownloadProgress;
  f.state.downloadCancelRequested = true;
  f.elements.downloadMessage.textContent = '正在取消下载';
  f.ui.updateDownloadProgress({ taskId: f.state.activeTaskId, phase: 'preparing', message: 'Late ignored event' });
  assert.equal(f.state.lastDownloadProgress, cached);
  f.ui.updateDownloadProgress(f.state.lastDownloadProgress);
  assert.equal(f.elements.downloadMessage.textContent, '正在取消下载');
  f.ui.updateDownloadProgress({ phase: 'cancelled', message: '下载已取消' });
  assert.equal(f.elements.downloadFiles.textContent, '文件 2 / 8');
  assert.equal(f.elements.downloadSize.textContent, '1.0 MB / 4.0 MB');
});

test('new tasks and processing stages clear previous counters and per-stage network metadata', () => {
  const f = fixture();
  f.ui.updateDownloadProgress({ taskId: f.state.activeTaskId, phase: 'downloading-loader',
    completedBytes: 1048576, totalBytes: 4194304, totalBytesKnown: true,
    completedFiles: 2, totalFiles: 8, bytesPerSecond: 1048576, etaSeconds: 3, message: 'Old stage' });
  f.ui.updateDownloadProgress({ phase: 'installing-loader', completedFiles: 1, totalFiles: 2, message: 'Installing' });
  assert.equal(f.elements.downloadSize.textContent, '已完成 1 / 2 个文件');
  assert.equal(f.state.lastDownloadProgress.totalBytes, 0);
  assert.equal(f.state.lastDownloadProgress.totalBytesKnown, undefined);
  assert.equal(f.state.lastDownloadProgress.bytesPerSecond, undefined);
  f.ui.updateDownloadProgress({ phase: 'complete' });
  f.state.activeTaskId = 'new-install';
  f.ui.updateDownloadProgress({ taskId: 'new-install', phase: 'preparing', message: 'New task' });
  assert.equal(f.elements.downloadSize.textContent, '大小 —');
  assert.equal(f.elements.downloadFiles.textContent, '文件数 —');
  assert.equal(f.state.lastDownloadProgress.completedFiles, 0);
  assert.equal(f.state.lastDownloadProgress.message, 'New task');
});
