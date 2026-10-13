export function createLauncherUpdateUi(context) {
  const { updaterApi, elements, renderProgressBar, showToast, showProblem,
    ensureSettingsOpen } = context;
  const { launcherUpdateStatus, launcherVersionMeta, updateStatusBadge, updateStatusBadgeSvg,
    updateBadgeRefresh, updateBadgeCheck, updateBadgeDownload, updateBadgeError,
    launcherUpdateProgress, launcherUpdateButton, launcherUpdateNotesSetting,
    launcherUpdateNotes, settingsDialog } = elements;
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
    launcherUpdateProgress.hidden = !['downloading', 'verifying'].includes(state.status);
    const updatePercent = renderProgressBar(launcherUpdateProgress, state.progress, 100,
      state.status === 'downloaded');
    if (state.status === 'verifying') launcherUpdateProgress.removeAttribute('value');
    launcherUpdateButton.disabled = ['checking', 'downloading', 'verifying', 'unavailable'].includes(state.status);
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
              : '检查更新';
    renderNotes(state);
    if (downloadFailed) showToast(`下载失败：${state.message ?? '启动器更新下载失败'}`, true);
  }

  async function handle() {
    try {
      if (currentState.status === 'available') render(await updaterApi.download());
      else if (currentState.status === 'downloaded') await updaterApi.install();
      else render(await updaterApi.check());
    } catch (error) {
      showProblem(error);
    }
  }

  async function openSettings() {
    await ensureSettingsOpen();
    settingsDialog.querySelector('.launcher-update-setting')?.scrollIntoView({ block: 'center' });
    launcherUpdateButton.focus();
  }

  async function handleFromBadge() {
    await openSettings();
    await handle();
  }

  return { render, handle, openSettings, handleFromBadge };
}
