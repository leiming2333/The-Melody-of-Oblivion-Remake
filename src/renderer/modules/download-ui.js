(function exposeUiModules(root) {
  function createDownloadUi(context) {
    const { state, sourceHint, cancelDownloadButton, homeCancelDownloadButton, taskButton, downloadStatus,
      downloadMessage, downloadStage, downloadProgress, downloadPercent, gameStatus, statusBadge,
      downloadSpeed, downloadEta, renderProgressBar } = context;
    function updateDownloadProgress(progress) {
      if (progress.taskId && progress.taskId !== state.activeTaskId) return;
      if (progress.sourceLabel) {
        const measured = Number(progress.sourceThroughput);
        const speed = Number.isFinite(measured) && measured > 0
          ? ` · 测速 ${(measured / 1024 / 1024).toFixed(1)} MB/s` : '';
        sourceHint.textContent = `${progress.sourceLabel}${speed} · ${state.launcherSettings.downloadConcurrency} 路并发`;
      }
      state.lastDownloadProgress = progress;
      if (!state.versionDownloadActive) return;
      if (progress.cancellable === false) state.downloadCancellable = false;
      cancelDownloadButton.disabled = state.downloadCancelRequested || !state.downloadCancellable;
      homeCancelDownloadButton.hidden = !state.downloadCancellable;
      homeCancelDownloadButton.disabled = state.downloadCancelRequested;
      taskButton.hidden = false;
      if (state.downloadCancelRequested && !['complete', 'cancelled', 'failed'].includes(progress.phase)) return;
      downloadStatus.hidden = false;
      downloadMessage.textContent = progress.message ?? '正在准备下载…';
      downloadStage.textContent = {
        preparing: '准备下载',
        'preparing-base': '准备基础游戏',
        benchmarking: '测速',
        'downloading-base': '基础游戏下载',
        'base-ready': '基础游戏就绪',
        'verifying-installer': '校验安装器',
        'preparing-loader': '读取加载器依赖',
        'downloading-loader': '加载器下载',
        'installing-loader': '安装加载器',
        'installing-base': '安装基础游戏',
        'resolving-files': '解析整合包',
        'downloading-files': '整合包下载',
        'copying-overrides': '整理整合包',
        'committing-instance': '保存整合包',
        'extracting': '解压整合包',
        'waiting-for-files': '等待补齐',
        cancelled: '已取消',
        failed: '未完成',
        complete: '完成'
      }[progress.phase] ?? '下载';

      const totalFiles = progress.totalFiles ?? 0;
      const completedFiles = progress.completedFiles ?? 0;
      const totalBytes = progress.totalBytes ?? 0;
      const completedBytes = progress.completedBytes ?? 0;
      const useByteProgress = progress.totalBytesKnown !== false && totalBytes > 0;
      const progressTotal = useByteProgress ? totalBytes : totalFiles;
      const progressValue = useByteProgress ? completedBytes : completedFiles;
      const percent = renderProgressBar(downloadProgress, progressValue, progressTotal, progress.phase === 'complete');
      downloadPercent.textContent = percent === null ? '—' : `${percent}%`;

      // 主页状态条同步显示实时下载进度，避免下载进行中误显"下载失败"
      if (state.activeDownloadLabel && !['waiting-for-files', 'cancelled', 'failed'].includes(progress.phase)) {
        if (progress.phase === 'complete') {
          gameStatus.textContent = `${state.activeDownloadLabel} 下载完成`;
        } else if (['preparing', 'preparing-base', 'installing-base'].includes(progress.phase)) {
          gameStatus.textContent = `正在准备 ${state.activeDownloadLabel}`;
        } else if (progress.phase === 'installing-loader' || progress.phase === 'base-ready') {
          gameStatus.textContent = `正在安装 ${state.activeDownloadLabel}`;
        } else if (progress.phase === 'copying-overrides' || progress.phase === 'committing-instance') {
          gameStatus.textContent = `正在整理 ${state.activeDownloadLabel}`;
        } else if (progress.phase === 'resolving-files') {
          gameStatus.textContent = `正在解析 ${state.activeDownloadLabel} 文件`;
        } else {
          gameStatus.textContent = percent === null
            ? `正在处理 ${state.activeDownloadLabel}`
            : `正在下载 ${state.activeDownloadLabel} · ${percent}%`;
        }
        statusBadge.textContent = 'DOWNLOAD';
      }

      const bytesPerSecond = Number(progress.bytesPerSecond);
      if (progress.phase === 'complete') {
        downloadSpeed.textContent = '速度 —';
        downloadEta.textContent = '已完成';
      } else if (Number.isFinite(bytesPerSecond) && bytesPerSecond > 0) {
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        let value = bytesPerSecond;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
          value /= 1024;
          unitIndex += 1;
        }
        downloadSpeed.textContent = `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;

        const etaSeconds = Number(progress.etaSeconds);
        if (Number.isFinite(etaSeconds) && etaSeconds >= 0) {
          const minutes = Math.floor(etaSeconds / 60);
          const seconds = Math.ceil(etaSeconds % 60);
          downloadEta.textContent = minutes > 0
            ? `剩余 ${minutes} 分 ${seconds} 秒`
            : `剩余 ${seconds} 秒`;
        } else {
          downloadEta.textContent = '剩余时间计算中';
        }
      } else if (progress.phase === 'benchmarking') {
        downloadSpeed.textContent = '正在测速';
        downloadEta.textContent = '剩余时间 —';
      } else {
        downloadSpeed.textContent = '速度计算中';
        downloadEta.textContent = '剩余时间 —';
      }

    }


    return { updateDownloadProgress };
  }
  const exported = { createDownloadUi };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else Object.assign(root.launcherUiModules ??= {}, exported);
})(globalThis);
