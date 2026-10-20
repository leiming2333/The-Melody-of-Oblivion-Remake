export function createModpackUi(context) {
  const { state, minecraft, showToast, readableError, gameStatus, statusBadge,
    cancelDownloadButton, downloadStatus } = context;
  const elements = context.elements ?? {};
  let sourcePath, sourceName, selectedOptions = { installOptionalFiles: false };
  let waiting = null;
  let failed = false;
  const makeId = () => context.newTaskId?.() ?? globalThis.crypto?.randomUUID?.() ?? `pack-${Date.now()}`;

  function refresh() {
    const active = Boolean(state.versionDownloadActive);
    context.updateTaskEntry?.({ visible: active || Boolean(waiting) || failed, retry: failed && !waiting });
    context.updateVersionAction();
    if (elements.recoveryPanel) elements.recoveryPanel.hidden = !waiting;
    if (elements.resumeButton) elements.resumeButton.disabled = active;
    if (elements.discardButton) elements.discardButton.disabled = active;
    if (elements.missingFiles) {
      elements.missingFiles.replaceChildren();
      for (const file of waiting?.files ?? []) {
        const row = document.createElement('li');
        const label = document.createElement('span');
        const reason = file.reason === 'metadata-unavailable' ? '等待文件信息'
          : file.reason === 'restricted' ? '需要手动下载' : '下载未完成';
        label.textContent = `${file.fileName ?? `项目 ${file.projectId} · 文件 ${file.fileId}`} · ${reason}`;
        row.append(label);
        if (file.officialUrl) {
          const link = document.createElement('button');
          link.type = 'button'; link.className = 'secondary-dialog-button'; link.textContent = '官方页面';
          link.addEventListener('click', () => {
            void context.openExternal?.(file.officialUrl)?.catch((error) => context.showProblem?.(error));
          });
          row.append(link);
        }
        const select = document.createElement('button');
        select.type = 'button'; select.className = 'secondary-dialog-button'; select.textContent = '选择文件';
        select.disabled = active || !file.canImport;
        if (!file.canImport) select.title = '先重新查询文件信息与摘要，再选择本地文件';
        select.addEventListener('click', () => { void selectFile(file); });
        row.append(select);
        elements.missingFiles.append(row);
      }
    }
  }

  function begin(message) {
    state.versionDownloadActive = true;
    state.modpackInstallActive = true;
    state.downloadCancelRequested = false;
    state.activeTaskId = makeId();
    state.activeDownloadLabel = sourceName ?? '整合包';
    state.downloadCancellable = true;
    failed = false;
    cancelDownloadButton.hidden = false;
    cancelDownloadButton.disabled = false;
    downloadStatus.hidden = false;
    gameStatus.textContent = message;
    statusBadge.textContent = 'MODPACK';
    context.updateDownloadProgress({ phase: 'preparing', message, taskId: state.activeTaskId, cancellable: true });
    refresh();
    return state.activeTaskId;
  }

  function finish() {
    state.modpackInstallActive = false;
    state.versionDownloadActive = false;
    state.downloadCancelRequested = false;
    state.activeTaskId = '';
    state.downloadCancellable = true;
    cancelDownloadButton.hidden = true;
    cancelDownloadButton.disabled = false;
    refresh();
  }

  async function outcome(result) {
    if (result.status === 'waiting-for-files') {
      waiting = result;
      gameStatus.textContent = `${result.name} 需要补齐文件`;
      statusBadge.textContent = 'WAITING';
      if (elements.recoveryTitle) elements.recoveryTitle.textContent = `${result.name} · ${result.files.length} 个文件待处理`;
      context.updateDownloadProgress({ phase: 'waiting-for-files', message: '请补齐缺失文件，或重新查询后继续',
        taskId: state.activeTaskId, cancellable: false });
      showToast('安装已暂停，已校验的文件会保留');
      context.openTask?.();
      return;
    }
    waiting = null;
    await context.loadLocalProfiles(true);
    context.useVersion(result.targetId, result.name);
    context.updateDownloadProgress({ phase: 'complete', message: `${result.name} 安装完成`, taskId: state.activeTaskId });
    gameStatus.textContent = `${result.name} 安装完成`;
    statusBadge.textContent = 'SELECTED';
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
    showToast(warnings.length ? `${result.name} 已安装，${warnings.length} 个可选文件未安装。`
      : `${result.name} 已安装并设为当前游戏`);
    if (warnings.length) context.showProblem?.({ message: warnings.join('\n'), code: 'MODPACK_OPTIONAL_SKIPPED' },
      '部分可选文件未安装', { domain: 'modpack' });
  }

  function reportFailure(error, retry, preserveWaiting = false) {
    const message = readableError(error);
    const cancelled = error?.code === 'TASK_CANCELLED' || error?.name === 'AbortError' || message === '下载已取消';
    if (!preserveWaiting) waiting = null;
    failed = !cancelled && !waiting;
    gameStatus.textContent = cancelled ? '整合包操作已取消' : waiting ? '整合包等待补齐文件' : '整合包安装未完成，可重试';
    statusBadge.textContent = cancelled ? 'READY' : waiting ? 'WAITING' : 'ERROR';
    context.updateDownloadProgress({ phase: cancelled ? 'cancelled' : 'failed', message: cancelled
      ? '操作已取消，已校验文件可在下次安装时复用' : message, taskId: state.activeTaskId, cancellable: false });
    if (cancelled) showToast('操作已取消，已校验文件会保留');
    else {
      showToast(`整合包安装未完成：${message}`, true);
      context.showProblem?.(error, '整合包安装未完成', { retry, domain: 'modpack' });
    }
  }

  async function install(filePath) {
    if (state.versionDownloadActive || state.modpackInstallActive) {
      showToast('请先等待当前安装任务完成或取消'); return;
    }
    sourcePath = filePath; sourceName = filePath.split(/[\\/]/).at(-1); waiting = null;
    begin(`正在检查 ${sourceName}…`);
    try {
      const info = minecraft?.inspectModpack ? await minecraft.inspectModpack(filePath, { taskId: state.activeTaskId })
        : { name: sourceName, format: 'modrinth', fileCount: 0 };
      sourceName = info.name;
      cancelDownloadButton.hidden = true;
      let choice;
      if (context.confirmPack) choice = await context.confirmPack(info);
      else choice = window.confirm(`安装整合包「${info.name}」？`) ? { installOptionalFiles: false } : null;
      if (!choice) { failed = false; return; }
      selectedOptions = { installOptionalFiles: choice.installOptionalFiles === true };
      const taskId = begin(`正在安装整合包 ${info.name}`);
      const result = minecraft?.installModpack ? await minecraft.installModpack(filePath, { ...selectedOptions, taskId })
        : { name: info.name, targetId: 'instance-preview', warnings: [] };
      await outcome(result);
    } catch (error) { reportFailure(error, retry); }
    finally { finish(); }
  }

  async function retry() {
    if (!sourcePath || state.versionDownloadActive) return;
    const taskId = begin(`正在重试 ${sourceName}`);
    try { await outcome(await minecraft.installModpack(sourcePath, { ...selectedOptions, taskId })); }
    catch (error) { reportFailure(error, retry); }
    finally { finish(); }
  }

  async function resume() {
    if (!waiting || state.versionDownloadActive) return;
    const sessionId = waiting.sessionId;
    const taskId = begin(`正在继续 ${sourceName}`);
    try { await outcome(await minecraft.resumeModpack(sessionId, { taskId })); }
    catch (error) {
      if (/SESSION|SOURCE_CHANGED|ARCHIVE_CHANGED/.test(error.code ?? '')) waiting = null;
      reportFailure(error, waiting ? resume : retry, Boolean(waiting));
    } finally { finish(); }
  }

  async function selectFile(file) {
    if (!waiting || state.versionDownloadActive) return;
    const sessionId = waiting.sessionId;
    const taskId = begin(`正在校验 ${file.fileName ?? '整合包文件'}`);
    try {
      const result = await minecraft.selectMissingModpackFile(sessionId,
        { projectId: file.projectId, fileId: file.fileId }, { taskId });
      if (!result.canceled) { waiting = result; showToast('文件校验通过，可继续安装'); }
      gameStatus.textContent = `${sourceName} 等待继续安装`;
      statusBadge.textContent = 'WAITING';
    } catch (error) {
      if (/SESSION|SOURCE_CHANGED|ARCHIVE_CHANGED/.test(error.code ?? '')) waiting = null;
      reportFailure(error, waiting ? () => selectFile(file) : retry, Boolean(waiting));
    }
    finally { finish(); }
  }

  async function discard() {
    if (!waiting || state.versionDownloadActive) return;
    try {
      await minecraft.discardModpackSession?.(waiting.sessionId);
      waiting = null; failed = false;
      gameStatus.textContent = '整合包安装已取消'; statusBadge.textContent = 'READY';
      refresh(); showToast('安装已取消，已校验文件会保留');
    } catch (error) { context.showProblem?.(error); }
  }

  function directoryChanged() {
    if (state.versionDownloadActive) return;
    const hadWaiting = Boolean(waiting);
    waiting = null; failed = false; sourcePath = undefined;
    refresh();
    if (hadWaiting) {
      gameStatus.textContent = '游戏目录已切换，请重新选择整合包';
      statusBadge.textContent = 'READY';
      downloadStatus.hidden = true;
    }
  }

  elements.resumeButton?.addEventListener('click', () => { void resume(); });
  elements.discardButton?.addEventListener('click', () => { void discard(); });
  return { install, retry, resume, selectFile, discard, directoryChanged };
}

export async function installDroppedModpack(context, filePath) {
  return createModpackUi(context).install(filePath);
}
