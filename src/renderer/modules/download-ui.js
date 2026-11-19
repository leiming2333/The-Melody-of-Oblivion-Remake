(function exposeUiModules(root) {
  function createDownloadUi(context) {
    const { state, sourceHint, cancelDownloadButton, homeCancelDownloadButton, taskButton, downloadStatus,
      downloadMessage, downloadStage, downloadProgress, downloadPercent, gameStatus, statusBadge,
      downloadSpeed, downloadEta, downloadSize, downloadFiles, renderProgressBar } = context;

    function nonnegativeNumber(value) {
      if (value === null || value === undefined || value === '') return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : null;
    }

    function formatBytes(bytes, suffix = '') {
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      let value = bytes;
      let unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
      }
      return `${value >= 100 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}${suffix}`;
    }

    function updateDownloadProgress(progress) {
      if (progress.taskId && progress.taskId !== state.activeTaskId) return;
      if (progress.sourceLabel) {
        const measured = Number(progress.sourceThroughput);
        const speed = Number.isFinite(measured) && measured > 0
          ? ` · 测速 ${(measured / 1024 / 1024).toFixed(1)} MB/s` : '';
        sourceHint.textContent = `${progress.sourceLabel}${speed} · ${state.launcherSettings.downloadConcurrency} 路并发`;
      }
      const previousProgress = state.lastDownloadProgress;
      if (!state.versionDownloadActive) {
        state.lastDownloadProgress = progress;
        return;
      }
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
        'loader-ready': 'Fabric 已就绪',
        'verifying-fabric-api': '校验 Fabric API',
        'installing-fabric-api': '安装 Fabric API',
        'committing-fabric-api': '保存 Fabric API',
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

      const terminal = ['complete', 'cancelled', 'failed'].includes(progress.phase);
      const sameTask = !previousProgress?.taskId || previousProgress.taskId === state.activeTaskId;
      const counts = (terminal || progress.phase === 'waiting-for-files') && previousProgress && sameTask
        ? { ...previousProgress, ...progress } : progress;
      const totalFiles = Math.floor(nonnegativeNumber(counts.totalFiles) ?? 0);
      const completedFiles = progress.phase === 'complete' && totalFiles > 0 ? totalFiles
        : Math.floor(nonnegativeNumber(counts.completedFiles) ?? 0);
      const totalBytes = nonnegativeNumber(counts.totalBytes) ?? 0;
      const useByteProgress = counts.totalBytesKnown !== false && totalBytes > 0;
      const completedBytes = progress.phase === 'complete' && useByteProgress ? totalBytes
        : nonnegativeNumber(counts.completedBytes) ?? 0;
      // Repeated terminal/waiting events and reopening the task retain counters,
      // while stage-specific messages and throughput always come from this event.
      state.lastDownloadProgress = { ...progress, totalFiles, completedFiles, totalBytes, completedBytes,
        ...(counts.totalBytesKnown === undefined ? {} : { totalBytesKnown: counts.totalBytesKnown }) };
      const progressTotal = useByteProgress ? totalBytes : totalFiles;
      const progressValue = useByteProgress ? completedBytes : completedFiles;
      const percent = renderProgressBar(downloadProgress, progressValue, progressTotal, progress.phase === 'complete');
      downloadPercent.textContent = percent === null ? '—' : `${percent}%`;

      if (downloadSize) {
        downloadSize.textContent = useByteProgress
          ? `${formatBytes(completedBytes)} / ${formatBytes(totalBytes)}`
          : completedBytes > 0 ? `已传输 ${formatBytes(completedBytes)}`
            : totalFiles > 0 ? `已完成 ${completedFiles} / ${totalFiles} 个文件` : '大小 —';
      }
      if (downloadFiles) {
        downloadFiles.textContent = totalFiles > 0 ? `文件 ${completedFiles} / ${totalFiles}`
          : completedFiles > 0 ? `已完成 ${completedFiles} 个文件` : '文件数 —';
      }

      // 主页状态条同步显示实时下载进度，避免下载进行中误显"下载失败"
      if (state.activeDownloadLabel && !['waiting-for-files', 'cancelled', 'failed'].includes(progress.phase)) {
        if (progress.phase === 'complete') {
          gameStatus.textContent = `${state.activeDownloadLabel} 下载完成`;
        } else if (['preparing', 'preparing-base', 'preparing-loader', 'benchmarking'].includes(progress.phase)) {
          gameStatus.textContent = `正在准备 ${state.activeDownloadLabel}`;
        } else if (['installing-loader', 'installing-base', 'base-ready', 'loader-ready', 'installing-fabric-api', 'committing-fabric-api'].includes(progress.phase)) {
          gameStatus.textContent = `正在安装 ${state.activeDownloadLabel}`;
        } else if (['verifying-installer', 'verifying-fabric-api'].includes(progress.phase)) {
          gameStatus.textContent = `正在校验 ${state.activeDownloadLabel}`;
        } else if (progress.phase === 'extracting') {
          gameStatus.textContent = `正在解压 ${state.activeDownloadLabel}`;
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

      const bytesPerSecond = nonnegativeNumber(progress.bytesPerSecond);
      const processingLabel = {
        preparing: '正在准备', 'preparing-base': '正在准备', 'preparing-loader': '正在读取依赖',
        'base-ready': '正在准备安装', 'verifying-installer': '正在校验',
        'loader-ready': '正在准备 Fabric API', 'verifying-fabric-api': '正在校验 Fabric API',
        'installing-fabric-api': '正在安装 Fabric API', 'committing-fabric-api': '正在保存 Fabric API',
        'installing-loader': '正在安装', 'installing-base': '正在安装',
        'resolving-files': '正在解析文件', 'copying-overrides': '正在整理文件',
        'committing-instance': '正在保存', extracting: '正在解压'
      }[progress.phase];
      const transferring = bytesPerSecond > 0 && (totalBytes > 0 || completedBytes > 0);
      if (progress.phase === 'complete') {
        downloadSpeed.textContent = '速度 —';
        downloadEta.textContent = '已完成';
      } else if (progress.phase === 'cancelled' || progress.phase === 'failed') {
        downloadSpeed.textContent = '速度 —';
        downloadEta.textContent = progress.phase === 'cancelled' ? '已取消' : '等待重试';
      } else if (progress.phase === 'waiting-for-files') {
        downloadSpeed.textContent = '速度 —';
        downloadEta.textContent = '等待补齐文件';
      } else if (progress.phase === 'benchmarking') {
        downloadSpeed.textContent = '正在测速';
        downloadEta.textContent = '剩余时间 —';
      } else if (processingLabel && !transferring) {
        downloadSpeed.textContent = processingLabel;
        downloadEta.textContent = '剩余时间 —';
      } else if (bytesPerSecond > 0) {
        downloadSpeed.textContent = formatBytes(bytesPerSecond, '/s');

        const etaSeconds = nonnegativeNumber(progress.etaSeconds);
        if (etaSeconds !== null) {
          const roundedSeconds = Math.ceil(etaSeconds);
          const minutes = Math.floor(roundedSeconds / 60);
          const seconds = roundedSeconds % 60;
          downloadEta.textContent = minutes > 0
            ? `剩余 ${minutes} 分 ${seconds} 秒`
            : `剩余 ${seconds} 秒`;
        } else {
          downloadEta.textContent = '剩余时间计算中';
        }
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
