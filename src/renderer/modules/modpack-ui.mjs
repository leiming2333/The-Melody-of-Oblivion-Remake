export async function installDroppedModpack(context, filePath) {
  const { state, showToast, minecraft, loaderNames, cancelDownloadButton, downloadStatus, gameStatus,
    statusBadge, updateDownloadProgress, updateVersionAction, delay, loadLocalProfiles,
    useVersion, readableError } = context;
  if (state.versionDownloadActive || state.modpackInstallActive) {
    showToast('请先等待当前安装任务完成或取消');
    return;
  }
  try {
    const info = minecraft?.inspectModpack
      ? await minecraft.inspectModpack(filePath)
      : {
          format: filePath.toLowerCase().endsWith('.mrpack') ? 'modrinth' : 'curseforge',
          name: filePath.split(/[\\/]/).at(-1),
          gameVersion: '1.21.1',
          loaderType: 'fabric',
          loaderVersion: '0.16.10',
          fileCount: 0
        };
    const formatName = info.format === 'modrinth' ? 'Modrinth' : 'CurseForge';
    const optionalCount = Number(info.optionalFileCount ?? 0);
    const requiredCount = Number(info.requiredFileCount ?? info.fileCount ?? 0);
    const optionalLine = optionalCount > 0
      ? `\n其中必需文件 ${requiredCount} 个，可选文件 ${optionalCount} 个。`
      : '';
    const installOptional = optionalCount > 0
      ? window.confirm(
          `安装整合包「${info.name}」？\n\n${formatName} · Minecraft ${info.gameVersion} · ${loaderNames[info.loaderType] ?? info.loaderType}\n需要下载 ${info.fileCount} 个整合包文件。${optionalLine}\n\n是否一并安装可选文件？取消则只安装必需文件。`
        )
      : window.confirm(
          `安装整合包「${info.name}」？\n\n${formatName} · Minecraft ${info.gameVersion} · ${loaderNames[info.loaderType] ?? info.loaderType}\n需要下载 ${info.fileCount} 个整合包文件。`
        );
    if (optionalCount === 0 && !installOptional) return;
    const installOptionalFiles = optionalCount > 0 ? installOptional : false;

    state.modpackInstallActive = true;
    state.versionDownloadActive = true;
    state.downloadCancelRequested = false;
    state.activeDownloadLabel = info.name;
    cancelDownloadButton.hidden = false;
    cancelDownloadButton.disabled = false;
    downloadStatus.hidden = false;
    gameStatus.textContent = `正在安装整合包 ${info.name}`;
    statusBadge.textContent = 'MODPACK';
    updateDownloadProgress({ phase: 'preparing', message: `正在准备 ${info.name}…` });
    updateVersionAction();

    const result = minecraft?.installModpack
      ? await minecraft.installModpack(filePath, { installOptionalFiles })
      : await delay(300).then(() => ({
          name: info.name,
          targetId: `instance-preview-${Date.now()}`,
          warnings: []
        }));
    await loadLocalProfiles(true);
    useVersion(result.targetId, result.name);
    gameStatus.textContent = `${result.name} 安装完成`;
    statusBadge.textContent = 'SELECTED';
    const warnings = Array.isArray(result.warnings) ? result.warnings.filter(Boolean) : [];
    if (warnings.length > 0) {
      showToast(`${result.name} 已安装，但 ${warnings.length} 个可选文件未安装：${warnings[0]}`);
    } else {
      showToast(`${result.name} 已安装并设为当前游戏`);
    }
  } catch (error) {
    const message = readableError(error);
    const cancelled = state.downloadCancelRequested || message.includes('下载已取消');
    gameStatus.textContent = cancelled ? '整合包安装已取消' : '整合包安装失败，可重新拖入重试';
    statusBadge.textContent = cancelled ? 'READY' : 'ERROR';
    showToast(cancelled ? '整合包安装已取消' : `下载失败：${message}，可重新拖入整合包重试`, !cancelled);
  } finally {
    state.modpackInstallActive = false;
    state.versionDownloadActive = false;
    state.downloadCancelRequested = false;
    cancelDownloadButton.hidden = true;
    cancelDownloadButton.disabled = false;
    updateVersionAction();
  }
}
