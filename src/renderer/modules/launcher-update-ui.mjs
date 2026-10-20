export function createLauncherUpdateUi(context) {
  const { updaterApi, elements, renderProgressBar, showToast, showProblem,
    ensureSettingsOpen } = context;
  const { launcherUpdateStatus, launcherVersionMeta, updateStatusBadge, updateStatusBadgeSvg,
    updateBadgeRefresh, updateBadgeCheck, updateBadgeDownload, updateBadgeError,
    launcherUpdateProgress, launcherUpdateButton, launcherUpdateNotesSetting,
    launcherUpdateNotes, settingsDialog } = elements;
  const { launcherUpdateCancelButton, launcherUpdateRecovery, launcherUpdateRecoveryMessage,
    launcherUpdateRetryButton, launcherUpdateRollbackButton, launcherUpdateKeepButton,
    launcherHistorySetting, launcherHistoryButton, launcherHistoryList, launcherHistoryCleanupButton } = elements;
  let currentState = { status: 'idle', progress: 0, installAction: null, message: '尚未检查更新' };

  function renderNotes(state) {
    if (!launcherUpdateNotesSetting || !launcherUpdateNotes) return;
    const notes = typeof state.releaseNotes === 'string' && state.releaseNotes.trim()
      ? state.releaseNotes : '';
    const visible = Boolean(notes)
      && ['available', 'downloading', 'verifying', 'downloaded', 'error'].includes(state.status);
    launcherUpdateNotesSetting.hidden = !visible;
    if (visible) launcherUpdateNotes.textContent = notes;
  }

  function render(state = currentState) {
    const downloadFailed = state.status === 'error'
      && ['downloading', 'verifying'].includes(currentState.status);
    currentState = state;
    launcherUpdateStatus.textContent = state.message ?? '尚未检查更新';
    if (state.currentVersion) launcherVersionMeta.textContent = `Launcher ${state.currentVersion}`;
    const hasUpdate = Boolean(state.availableVersion)
      || ['available', 'downloading', 'verifying', 'downloaded'].includes(state.status);
    const isCurrent = state.status === 'current';
    const hasError = state.status === 'error';
    updateStatusBadge.classList.toggle('has-update', hasUpdate);
    updateStatusBadge.classList.toggle('is-current', isCurrent);
    updateStatusBadge.classList.toggle('has-error', hasError);
    updateStatusBadge.title = state.message ?? '尚未检查更新';
    updateStatusBadge.setAttribute('aria-label', state.message ?? '检查启动器更新');
    updateBadgeRefresh.hidden = hasUpdate || isCurrent || hasError;
    updateBadgeCheck.hidden = !isCurrent;
    updateBadgeDownload.hidden = !hasUpdate;
    updateBadgeError.hidden = !hasError;
    if (updateStatusBadgeSvg) updateStatusBadge.classList.toggle('is-spinning', state.status === 'checking');
    launcherUpdateProgress.hidden = !['downloading', 'verifying', 'preparing', 'cancelling'].includes(state.status);
    const updatePercent = renderProgressBar(launcherUpdateProgress, state.progress, 100,
      state.status === 'downloaded');
    if (state.status === 'verifying') launcherUpdateProgress.removeAttribute('value');
    launcherUpdateButton.disabled = Boolean(state.recovery)
      || ['checking', 'downloading', 'verifying', 'preparing', 'installing', 'cancelling', 'unavailable'].includes(state.status);
    launcherUpdateButton.textContent = state.status === 'available'
      ? `下载 ${state.availableVersion ?? '更新'}`
      : state.status === 'downloaded'
        ? (state.installAction === 'open-folder' ? '打开下载位置' : '重启并安装')
        : state.status === 'checking'
          ? '正在检查…'
          : state.status === 'verifying'
            ? '正在校验…'
            : state.status === 'downloading'
              ? (updatePercent === null ? '下载中' : `${updatePercent}%`)
              : state.status === 'preparing' ? '准备安装…'
                : state.status === 'installing' ? '正在安装…'
                  : state.status === 'cancelling' ? '正在取消…'
                    : state.status === 'error' && state.availableVersion ? '重试下载' : '检查更新';
    if (launcherUpdateCancelButton) {
      launcherUpdateCancelButton.hidden = !state.canCancel && state.status !== 'cancelling';
      launcherUpdateCancelButton.disabled = state.status === 'cancelling';
      launcherUpdateCancelButton.textContent = state.status === 'cancelling' ? '正在取消…' : '取消';
    }
    if (launcherUpdateRecovery) {
      launcherUpdateRecovery.hidden = !state.recovery && !state.rollbackAvailable;
      launcherUpdateRecoveryMessage.textContent = state.recovery?.message
        ?? `保留了可回退版本 ${state.rollbackVersion ?? ''}。恢复后会重新启动。`;
      const actions = state.recovery?.actions ?? (state.rollbackAvailable ? ['rollback'] : []);
      for (const [button, action] of [[launcherUpdateRetryButton, 'retry'], [launcherUpdateRollbackButton, 'rollback'],
        [launcherUpdateKeepButton, 'keep-current']]) {
        button.hidden = !actions.includes(action);
        button.disabled = ['preparing', 'installing', 'cancelling'].includes(state.status);
      }
    }
    if (launcherHistorySetting) launcherHistorySetting.hidden = state.platform !== 'win32';
    renderNotes(state);
    if (downloadFailed) {
      showToast(`下载失败：${state.message ?? '启动器更新下载失败'}`, true);
      showProblem({ message: state.message, code: state.errorCode }, '启动器更新未完成', { domain: 'update', retry: handle });
    }
  }

  async function handle() {
    try {
      if (currentState.status === 'available') render(await updaterApi.download());
      else if (currentState.status === 'downloaded') {
        const result = await updaterApi.install();
        if (result?.status) render(result);
      } else if (currentState.status === 'error' && currentState.availableVersion) {
        const checked = await updaterApi.check();
        render(checked);
        if (checked.status === 'available') render(await updaterApi.download());
      }
      else render(await updaterApi.check());
    } catch (error) {
      showProblem(error, '启动器更新未完成', { domain: 'update', retry: handle });
    }
  }

  async function openSettings() {
    await ensureSettingsOpen();
    settingsDialog.querySelector('.launcher-update-setting')?.scrollIntoView({ block: 'center' });
    launcherUpdateButton.focus();
  }

  async function handleFromBadge() {
    await openSettings();
    if (currentState.recovery) return;
    await handle();
  }

  async function cancel() {
    if (!currentState.canCancel) return;
    launcherUpdateCancelButton.disabled = true;
    try { render(await updaterApi.cancel()); }
    catch (error) {
      render(currentState);
      showProblem(error, '取消更新未完成', { domain: 'update' });
    }
  }

  async function recover(action) {
    try {
      if (action === 'rollback' && context.confirmRollback
          && !await context.confirmRollback(currentState.rollbackVersion)) return;
      const result = await updaterApi.recover(action);
      if (result?.status) render(result);
    } catch (error) { showProblem(error, '更新恢复未完成', { domain: 'update' }); }
  }

  async function loadHistory() {
    try {
      const result = await updaterApi.listHistory();
      const files = Array.isArray(result) ? result : result.files ?? [];
      launcherHistoryList.replaceChildren();
      launcherHistoryList.hidden = false;
      launcherHistoryCleanupButton.hidden = files.length === 0;
      if (!files.length) {
        const empty = document.createElement('li'); empty.textContent = '没有可手动清理的历史更新文件';
        launcherHistoryList.append(empty);
      }
      for (const file of files) {
        const row = document.createElement('li'); const label = document.createElement('label');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = file.id;
        const text = document.createElement('span'); text.textContent = file.name ?? file.path;
        const detail = document.createElement('small');
        detail.textContent = `${file.path ?? ''} · ${((file.size ?? 0) / 1048576).toFixed(1)} MB`;
        text.append(detail); label.append(checkbox, text); row.append(label); launcherHistoryList.append(row);
      }
    } catch (error) { showProblem(error, '读取历史更新文件失败', { domain: 'update' }); }
  }

  async function cleanupHistory() {
    const ids = [...launcherHistoryList.querySelectorAll('input:checked')].map((input) => input.value);
    if (!ids.length) { showToast('请先勾选需要回收的旧文件'); return; }
    launcherHistoryCleanupButton.disabled = true;
    try {
      const result = await updaterApi.cleanupHistory(ids);
      showToast(result?.skipped?.length ? '部分文件已变化或无法回收，可重新查看后重试' : '已将选中的历史文件移入回收站');
      await loadHistory();
    } catch (error) { showProblem(error, '回收旧文件失败', { domain: 'update' }); }
    finally { launcherHistoryCleanupButton.disabled = false; }
  }

  launcherUpdateCancelButton?.addEventListener('click', () => { void cancel(); });
  launcherUpdateRetryButton?.addEventListener('click', () => { void recover('retry'); });
  launcherUpdateRollbackButton?.addEventListener('click', () => { void recover('rollback'); });
  launcherUpdateKeepButton?.addEventListener('click', () => { void recover('keep-current'); });
  launcherHistoryButton?.addEventListener('click', () => { void loadHistory(); });
  launcherHistoryCleanupButton?.addEventListener('click', () => { void cleanupHistory(); });

  return { render, handle, openSettings, handleFromBadge, cancel, recover, loadHistory, cleanupHistory };
}
