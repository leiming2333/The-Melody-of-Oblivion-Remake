function taskApi(api) {
  if (!api) return api;
  return Object.fromEntries(Object.entries(api).map(([name, value]) => [name,
    typeof value !== 'function' ? value : (...args) => {
      const result = value(...args);
      if (!result || typeof result.then !== 'function') return result;
      return result.then((payload) => {
        if (!payload?.__launcherTaskError) return payload;
        const detail = payload.__launcherTaskError;
        throw Object.assign(new Error(detail.message), detail);
      });
    }
  ]));
}

const bridgeEnvironment = window.launcherEnvironment;
const environment = bridgeEnvironment ? { ...bridgeEnvironment,
  minecraft: taskApi(bridgeEnvironment.minecraft), updater: taskApi(bridgeEnvironment.updater),
  startup: taskApi(bridgeEnvironment.startup) } : undefined;
const localGameDirectoryHint = '游戏文件将生成在启动器所在目录的 .minecraft 文件夹中。';
const windowControls = environment?.windowControls;
const minecraft = environment?.minecraft;
const accountsApi = environment?.accounts;
const settingsApi = environment?.settings;
const updaterApi = environment?.updater;
const filesApi = environment?.files;

// 禁止复制文字：屏蔽右键菜单、复制、剪切（输入框除外）
document.addEventListener('contextmenu', (event) => {
  const tag = event.target?.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') event.preventDefault();
});
document.addEventListener('copy', (event) => {
  const tag = event.target?.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') event.preventDefault();
});
document.addEventListener('cut', (event) => {
  const tag = event.target?.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') event.preventDefault();
});
document.addEventListener('selectstart', (event) => {
  const tag = event.target?.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') event.preventDefault();
});

const launchButton = document.querySelector('#launchButton');
const launchLabel = document.querySelector('#launchLabel');
const launchHint = document.querySelector('#launchHint');
const homeStatus = document.querySelector('#homeStatus');
const gameStatus = document.querySelector('#gameStatus');
const statusBadge = document.querySelector('#statusBadge');
const accountButton = document.querySelector('#accountButton');
const playerAvatar = document.querySelector('#playerAvatar');
const accountName = document.querySelector('#accountName');
const accountType = document.querySelector('#accountType');
const accountDialog = document.querySelector('#accountDialog');
const accountList = document.querySelector('#accountList');
const accountEmpty = document.querySelector('#accountEmpty');
const offlineNameInput = document.querySelector('#offlineNameInput');
const offlineSkinModelInputs = [...document.querySelectorAll('input[name="offlineSkinModel"]')];
const addOfflineButton = document.querySelector('#addOfflineButton');
const accountFormHint = document.querySelector('#accountFormHint');
const microsoftLoginButton = document.querySelector('#microsoftLoginButton');
const microsoftDevicePanel = document.querySelector('#microsoftDevicePanel');
const microsoftDeviceCode = document.querySelector('#microsoftDeviceCode');
const microsoftCopyCodeButton = document.querySelector('#microsoftCopyCodeButton');
const microsoftLoginHint = document.querySelector('#microsoftLoginHint');
const microsoftCancelLoginButton = document.querySelector('#microsoftCancelLoginButton');
const littleSkinUsernameInput = document.querySelector('#littleSkinUsernameInput');
const littleSkinPasswordInput = document.querySelector('#littleSkinPasswordInput');
const littleSkinLoginButton = document.querySelector('#littleSkinLoginButton');
const littleSkinLoginHint = document.querySelector('#littleSkinLoginHint');
const versionSelect = document.querySelector('#versionSelect');
const versionDialog = document.querySelector('#versionDialog');
const versionCloseButtons = [...versionDialog.querySelectorAll('[value="cancel"]')];
const versionCatalog = document.querySelector('#versionCatalog');
const versionSearch = document.querySelector('#versionSearch');
const versionTypeFilter = document.querySelector('#versionTypeFilter');
const loaderTypeSelect = document.querySelector('#loaderTypeSelect');
const loaderVersionSelect = document.querySelector('#loaderVersionSelect');
const versionEmpty = document.querySelector('#versionEmpty');
const versionSelectionSummary = document.querySelector('#versionSelectionSummary');
const addFabricApiButton = document.querySelector('#addFabricApiButton');
const refreshVersionsButton = document.querySelector('#refreshVersionsButton');
const deleteVersionButton = document.querySelector('#deleteVersionButton');
const clearVersionSelectionButton = document.querySelector('#clearVersionSelectionButton');
const downloadVersionButton = document.querySelector('#downloadVersionButton');
const cancelDownloadButton = document.querySelector('#cancelDownloadButton');
const taskButton = document.querySelector('#taskButton');
const homeCancelDownloadButton = document.querySelector('#homeCancelDownloadButton');
const retryTaskButton = document.querySelector('#retryTaskButton');
const downloadStatus = document.querySelector('#downloadStatus');
const downloadMessage = document.querySelector('#downloadMessage');
const downloadStage = document.querySelector('#downloadStage');
const downloadPercent = document.querySelector('#downloadPercent');
const downloadProgress = document.querySelector('#downloadProgress');
const downloadSpeed = document.querySelector('#downloadSpeed');
const downloadEta = document.querySelector('#downloadEta');
const downloadSize = document.querySelector('#downloadSize');
const downloadFiles = document.querySelector('#downloadFiles');
const settingsDialog = document.querySelector('#settingsDialog');
const launcherApp = document.querySelector('.launcher-app');
const javaSelect = document.querySelector('#javaSelect');
const javaBrowseButton = document.querySelector('#javaBrowseButton');
const javaRedetectButton = document.querySelector('#javaRedetectButton');
const javaDownloadButton = document.querySelector('#javaDownloadButton');
const javaDownloadPanel = document.querySelector('#javaDownloadPanel');
const javaDownloadVersionSelect = document.querySelector('#javaDownloadVersionSelect');
const javaDownloadStartButton = document.querySelector('#javaDownloadStartButton');
const javaDownloadCancelButton = document.querySelector('#javaDownloadCancelButton');
const javaDownloadHint = document.querySelector('#javaDownloadHint');
const javaDownloadProgress = document.querySelector('#javaDownloadProgress');
const javaDownloadPercent = document.querySelector('#javaDownloadPercent');
const gameDirectoryModeSelect = document.querySelector('#gameDirectoryModeSelect');
const isolateProfilesCheck = document.querySelector('#isolateProfilesCheck');
const gameDirectoryHint = document.querySelector('#gameDirectoryHint');
const memoryRange = document.querySelector('#memoryRange');
const memoryValue = document.querySelector('#memoryValue');
const downloadConcurrencySelect = document.querySelector('#downloadConcurrencySelect');
const downloadSourceSelect = document.querySelector('#downloadSourceSelect');
const autoUpdateCheck = document.querySelector('#autoUpdateCheck');
const launcherUpdatePolicySelect = document.querySelector('#launcherUpdatePolicySelect');
const launcherUpdateNotesSetting = document.querySelector('#launcherUpdateNotesSetting');
const launcherUpdateNotes = document.querySelector('#launcherUpdateNotes');
const launcherUpdateStatus = document.querySelector('#launcherUpdateStatus');
const launcherUpdateProgress = document.querySelector('#launcherUpdateProgress');
const launcherUpdateButton = document.querySelector('#launcherUpdateButton');
const launcherUpdateCancelButton = document.querySelector('#launcherUpdateCancelButton');
const launcherUpdateRecovery = document.querySelector('#launcherUpdateRecovery');
const launcherUpdateRecoveryMessage = document.querySelector('#launcherUpdateRecoveryMessage');
const launcherUpdateRetryButton = document.querySelector('#launcherUpdateRetryButton');
const launcherUpdateKeepButton = document.querySelector('#launcherUpdateKeepButton');
const launcherHistorySetting = document.querySelector('#launcherHistorySetting');
const launcherHistoryButton = document.querySelector('#launcherHistoryButton');
const launcherHistoryList = document.querySelector('#launcherHistoryList');
const launcherHistoryCleanupButton = document.querySelector('#launcherHistoryCleanupButton');
const launcherVersionMeta = document.querySelector('#launcherVersionMeta');
const updateStatusBadge = document.querySelector('#updateStatusBadge');
const updateBadgeRefresh = document.querySelector('#updateBadgeRefresh');
const updateBadgeCheck = document.querySelector('#updateBadgeCheck');
const updateBadgeDownload = document.querySelector('#updateBadgeDownload');
const updateBadgeError = document.querySelector('#updateBadgeError');
const updateStatusBadgeSvg = updateStatusBadge.querySelector('svg');
const sourceHint = document.querySelector('#sourceHint');
const toast = document.querySelector('#toast');
const modpackDropOverlay = document.querySelector('#modpackDropOverlay');
const wallpaperSlides = [...document.querySelectorAll('.background-slide')];
const wallpaperSelect = document.querySelector('#wallpaperSelect');

let toastTimer;
let localProfiles = [];
let localProfilesLoaded = false;
let localProfilesLoadingPromise;
let localProfilesLoadToken = 0;
let remoteVersions = [];
let filteredVersions = [];
let versionCatalogLoaded = false;
let versionCatalogLoading = false;
let versionCatalogLoadToken = 0;
let versionDownloadActive = false;
let fabricApiConfirmationActive = false;
let fabricApiConfirmationToken = 0;
let fabricApiUiModule;
let fabricApiUi;
let lastDownloadFailed = false;
let versionDeleteActive = false;
let versionVerifyActive = false;
let modpackInstallActive = false;
let launchRequestActive = false;
let downloadCancelRequested = false;
let activeTaskId = '';
let downloadCancellable = true;
let javaDownloadTaskId = '';
let activeDownloadLabel = '';
let lastDownloadProgress = null;
let loaderVersions = [];
let loaderCatalogLoading = false;
let loaderLoadToken = 0;
const activeGameProfiles = new Set();
let currentGameDirectory = '';
function gameProcessKey(targetId, directory = currentGameDirectory) {
  let normalized = String(directory).replaceAll('\\', '/').replace(/\/+$/, '');
  if (/^(?:[a-z]:|\/\/)/i.test(normalized)) normalized = normalized.toLowerCase();
  return JSON.stringify([normalized, targetId]);
}
const reportedRecoveryFiles = new Set();
function notifyStorageRecovery(state) {
  const recovery = state?.recovery;
  if (!recovery || reportedRecoveryFiles.has(recovery.filePath)) return;
  reportedRecoveryFiles.add(recovery.filePath);
  globalThis.window?.launcherEnvironment?.diagnostics?.reportError?.(
    `配置已从备份恢复：${recovery.filePath}\n备份：${recovery.backupPath}\n损坏副本：${recovery.quarantinePath ?? '原文件缺失'}`
  );
  showToast('检测到配置损坏，已从上次备份恢复；损坏原件已保留。请核对账户和启动设置。', true);
}
let accountState = { currentId: null, current: null, accounts: [] };
let launcherSettings = {
  wallpaperIndex: 3,
  javaPath: '',
  gameDirectoryMode: 'local',
  downloadSource: 'auto',
  downloadConcurrency: 16,
  memoryMb: 4096,
  autoUpdate: true,
  launcherUpdatePolicy: 'auto'
};
let launcherSettingsLoaded = false;
let launcherSettingsLoadingPromise;
let selectedJavaPath = '';
let selectedJavaMajorVersion;
let savedJavaRuntimes = [];
let autoJavaDetection = null;
let autoJavaDetectionPromise = null;
let javaEnvironmentKnown = false;
let javaReadiness = { status: 'idle' };
let javaDownloadActive = false;
let javaRequirementRequest = 0;
let javaFixActive = false;
let javaFixMajorVersion;
let javaFixTaskId = '';
let javaFixCancelRequested = false;
let microsoftLoginSessionId;
let microsoftLoginActive = false;
let microsoftLoginRequestId = 0;
let littleSkinLoginActive = false;
let launcherUpdateUiModule;
async function withLauncherUpdateUi(callback) {
  try {
    launcherUpdateUiModule ??= import('./modules/launcher-update-ui.mjs').then(({ createLauncherUpdateUi }) => (
      createLauncherUpdateUi({ updaterApi, renderProgressBar, showToast, showProblem,
        elements: { launcherUpdateStatus, launcherVersionMeta, updateStatusBadge, updateStatusBadgeSvg,
          updateBadgeRefresh, updateBadgeCheck, updateBadgeDownload, updateBadgeError,
          launcherUpdateProgress, launcherUpdateButton, launcherUpdateNotesSetting,
          launcherUpdateNotes, settingsDialog, launcherUpdateCancelButton, launcherUpdateRecovery,
          launcherUpdateRecoveryMessage, launcherUpdateRetryButton,
          launcherUpdateKeepButton, launcherHistorySetting, launcherHistoryButton, launcherHistoryList,
          launcherHistoryCleanupButton },
        ensureSettingsOpen
      })
    )).catch((error) => {
      launcherUpdateUiModule = undefined;
      throw error;
    });
    return await callback(await launcherUpdateUiModule);
  } catch (error) {
    showToast('更新界面加载失败：' + readableError(error), true);
  }
}

function renderLauncherUpdate(state) {
  return withLauncherUpdateUi((ui) => ui.render(state));
}

function handleLauncherUpdate() {
  return withLauncherUpdateUi((ui) => ui.handle());
}

function openLauncherUpdateSettings() {
  return withLauncherUpdateUi((ui) => ui.openSettings());
}

function handleLauncherUpdateFromBadge() {
  return withLauncherUpdateUi((ui) => ui.handleFromBadge());
}

const loaderNames = Object.freeze({
  vanilla: '原版',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  custom: '自定义'
});

const versionTypeNames = Object.freeze({
  release: '正式版',
  snapshot: '快照',
  old_beta: '早期测试版',
  old_alpha: '早期版本'
});

function versionTypeName(type) {
  return versionTypeNames[type] ?? '其他版本';
}

const skinModelNames = Object.freeze({
  steve: '史蒂夫',
  alex: '艾利克斯'
});

// Mojang 1.21.8 客户端内置的原始默认皮肤。内置数据可以在离线状态下正常显示。
const defaultSkinUrls = Object.freeze({
  steve: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAdVBMVEUAAAAKvLwAzMwmGgokGAgrHg0zJBE/KhW3g2uzeV5SPYn///+qclmbY0mQWT8Af38AaGhVVVWUYD52SzOBUzmPXj5JJRBCHQp3QjVqQDA0JRIoKCg3Nzc/Pz9KSko6MYlBNZtGOqUDenoFiIgElZUApKQAr6/wvakZAAAAAXRSTlMAQObYZgAAAolJREFUeNrt1l1rHucZReFrj/whu5hSCCQtlOTE/f+/Jz4q9Cu0YIhLcFVpVg+FsOCVehi8jmZgWOzZz33DM4CXlum3gH95GgeAzQZVeL4gTm6Cbp4vqFkD8HwBazPY8wWbMq9utu3mNZ5fotVezbzOE3kBEFbaZuc8kb00NTMUbWJp678Xf2GV7RRtx1TDQQ6XBNvsmL2+2vHq1TftmMPIyAWujtN2cl274ua2jpVpZneXEjjo7XW1q53V9ds4ODO5xIuhvGHvfLI3aixauig415uuO2+vl9+cncfsFw25zL650fXn687jqnXuP68/X3+eV3zE7y6u9eB73MlfAcfbTf3yR8CfAX+if8S/H5/EAbAxj5LN48tULvEBOh8V1AageMTXe2YHAOwHbZxrzPkSR3+ffr8TR2JDzE/4Fj8CDgEwDsW+q+9GsR07hhg2CsALBgMo2v5wNxXnQXMeGQVW7gUAyKI2m6KDsJ8Au3++F5RZO+kKNQjQcLLWgjwUjBXLltFgWWMUUlviocBgNoxNGgMjSxiYAA7zgLFo2hgIENiDU8gQCzDOmViGFAsEuBcQSDCothhpJaDRA8E5fHqH2nTbYm5fHLo1V0u3B7DAuheoeScRYabjjjuzs17cHVaTrTXmK78m9swP34d9oK/dfeXSIH2PW/MXwPvxN/bJlxw8zlYAcEyeI6gNgA/O8P8neN8xe1IHP2gTzegjvhUDfuRygmwEs2GE4mkCDIAzm2R4yAuPsIdR9k8AvMc+3L9+2UEjo4WP0FpgP19O0MzCsqxIoMsdDBvYcQyGmO0ZJRoYCKjLJWY0BAhYwGUBCgkh8MRdOKt+ruqMwAB2OcEX94U1TPbYJP0PkyyAI1S6cSIAAAAASUVORK5CYII=',
  alex: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAZlBMVEUAAAD////v2r/r0LDvu7HfxKLUt4/zqFiUyJKMvorrmD+GuYTljT97snjegS5xq26UlmuAglpvb29lZWV8Vz51UDhYWFhyTjZPT09sRi5kQSwjYiQrVChcOyc/Pz82NjYYOBYoKCgm8xoJAAAAAXRSTlMAQObYZgAAAwZJREFUeNrtlu1W6jAQRWtjWiaZtCC9/YgC8v4vec9Mg6Uur6b8ve6S0Lo8O2NYmClusOMGF7Nr8HKu2IoDTYPk44K6lvBciePNAm7mlTGz3G2voAaYZg9vFzCCjtnZqoHjAYHDJjAM1tqqgmR7Bahf9tFaA6zND6JwXRpxxosZIkz4uQzOWFmTrJPOUgdjOP1hzu7flmNrJe4wtCBoMgR1LVE1mNIYNbAurpafN5N5Xto8vZbl65PhWg0aRiU/C2Rpa0x5w/LHnjQwZVTgGk755+eyNMbWXDeukQIwMjaRm6qyJjmMtTAi1ziHF0OQQwsul+u1SJBnZsTbRJEgIqzxD8H1erksAt80MLTtCawFpvpScDqtKzhUYpA8yKgAv7Wq4GCripmT4PsKPFGIQxdjbFsPCPiDsbY6tAvBU2K+KRZiCHHquimC0ylGCoH8vjSmVEG4xb0Mmb2MYmGYpgH5boBA7iAIPuxL5CUtT0Q72u0wy6SDioVOosh3k5ggQIZgQB4iDITlOqwoFiaJwzJAcMJARhOShUCX3AGjWMWYYqHv+zghHntwPPaoWQJh58mLRe5FUSpQ6BenWDgi1B81rCAki0oIgiDvQRRlMkh+JdDgi2b78zieEUKEWglRG4gQp+8EEupTeOz78f39/U32n1oKb3iAQ642CWQfPlWAUAr3MtoQ2jck4XmTe7wL7ykPrFkJRkm9HCUuopF8CN6TXsGTEAjvt2+7Gu4Fl/N5xN+PMs6XCwZJLv4BER480MzHFsyfwi9ZpDNSYH7IIKcDPKB4iHSwPk7tVo974ZDYZ1VQ/PKfg9Nsddg6ouWfyCMNh2OqzBbBCdxXUDMq2Cq4r6CmDRVEoRvm4z4Q8OwowdmCbgDThEq8Jwg8pb4gSzANU5cY4l1ngCtDMM0NR4yYwfS5LzgoewXPXwuQ1bZDsIJJ2OJHPvcL49wQJEyGQI+5pV/o9Sj8IKcCSd31C5sFEhrv+gVrzAbBul9QINiwB+t+QdHWLBmyPgXtF8CtX5CO4LsK/gL4WlU0/HKH/gAAAABJRU5ErkJggg=='
});

const selectedGameStorageKey = 'melody.selected-game-target';
const JAVA_CHECK_SKIP_KEY = 'melody.java-check-skip';

function normalizedOnlineSkinUrl(value) {
  try {
    const parsed = new URL(String(value ?? ''));
    const hostname = parsed.hostname.toLowerCase();
    const isMinecraftTexture = hostname === 'textures.minecraft.net'
      && /^\/texture\/[a-f0-9]+$/i.test(parsed.pathname);
    const isLittleSkinTexture = hostname === 'littleskin.cn'
      || hostname.endsWith('.littleskin.cn');
    if (!isMinecraftTexture && !isLittleSkinTexture) return undefined;
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    parsed.protocol = 'https:';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function skinUrlForAccount(account) {
  if (account?.type === 'offline') {
    return defaultSkinUrls[account.skinModel] ?? defaultSkinUrls.steve;
  }
  return normalizedOnlineSkinUrl(account?.skinUrl)
    ?? defaultSkinUrls[account?.skinModel] ?? defaultSkinUrls.steve;
}

function applySkinAvatar(element, account) {
  const skinUrl = skinUrlForAccount(account);
  element.style.backgroundImage = skinUrl ? `url("${skinUrl}"), url("${skinUrl}")` : '';
  element.classList.toggle('has-player-skin', Boolean(skinUrl));
  element.classList.toggle('is-alex', account?.skinModel === 'alex');
}

function rememberSelectedGame(targetId) {
  try {
    if (targetId) window.localStorage.setItem(selectedGameStorageKey, targetId);
    else window.localStorage.removeItem(selectedGameStorageKey);
  } catch {}
}

function rememberedSelectedGame() {
  try {
    return window.localStorage.getItem(selectedGameStorageKey) ?? '';
  } catch {
    return '';
  }
}

function showToast(message, isError = false) {
  window.clearTimeout(toastTimer);
  if (toast.matches(':popover-open')) toast.hidePopover();
  toast.textContent = message;
  toast.classList.toggle('is-error', isError);
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  toast.showPopover();
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
    if (toast.matches(':popover-open')) toast.hidePopover();
  }, isError ? 6000 : 2800);
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function readableError(error) {
  const message = error?.message ?? String(error);
  globalThis.window?.launcherEnvironment?.diagnostics?.reportError?.(message);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|password|clientToken)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
}

function problemGuidance(message, code, domain) {
  if (code === 'CONFIG_CORRUPT' || /已损坏，且没有有效备份/.test(message)) {
    return { title: '配置文件需要恢复', message: '账户或设置文件已损坏，原文件已保留。',
      advice: '请展开错误详情查看原文件和备份路径，恢复有效备份后重试；不要删除账户文件来尝试修复。' };
  }
  if (code === 'ENOSPC' || /ENOSPC|空间不足|磁盘已满/.test(message)) {
    return { title: '存储空间不足', message: '当前目录没有足够空间完成操作。',
      advice: '释放磁盘空间后重试。已通过校验的整合包缓存会保留；请勿删除存档来处理此问题。' };
  }
  if (code === 'MODPACK_OPTIONAL_SKIPPED') {
    return { title: '部分可选文件未安装', message: '整合包已安装完成，部分可选内容暂时不可用。',
      advice: '可以先启动游戏。下方列出未安装的可选文件及原因。' };
  }
  if (/SESSION|SOURCE_CHANGED|ARCHIVE_CHANGED/.test(code ?? '')) {
    return { title: '需要重新导入整合包', message: '原整合包文件、游戏目录或恢复会话已改变。',
      advice: '重新拖入整合包。之前已校验的下载仍可复用。' };
  }
  if (/需要 Java|未找到可用的 Java|未检测到.*Java|无法启动 Java|不是可用的 Java/.test(message)) {
    return { title: 'Java 环境不可用', message: '当前 Java 环境不符合游戏要求，或所选程序无法运行。',
      advice: '可直接下载游戏所需的 Java 并自动重试启动，也可打开「启动设置」重新检测或手动选择 Java 可执行文件。', settings: true };
  }
  if (/SHA-?\d+|校验失败|校验.*不符|文件.*损坏|清单已损坏|文件缺失|不完整/i.test(message)) {
    if (domain === 'update') return { title: '更新包校验未通过', message: '更新包不完整或与官方摘要不符。',
      advice: '重新下载更新包后再安装，当前启动器和回退备份会保留。' };
    return { title: '游戏文件不完整', message: '文件缺失、损坏或校验不匹配，当前操作无法完成。',
      advice: '在版本管理中重新验证或下载该版本；整合包请重新获取可信来源的文件。保留存档和 mods，不要直接删除整个游戏目录。' };
  }
  if (/用户名或密码错误|登录被拒绝|invalid credentials|access_denied/i.test(message)) {
    return { title: '登录未完成', message: '登录信息不正确，或账户服务拒绝了本次请求。',
      advice: '前往「账户管理」确认登录方式并重新登录；检查账户是否可正常访问对应服务。', account: true };
  }
  if (/EACCES|EPERM|权限不足|拒绝访问/i.test(message)) {
    return { title: '无法访问文件', message: '启动器没有访问所需文件或目录的权限，或文件正在被其他程序使用。',
      advice: '关闭占用文件的游戏或程序，并选择可写目录后重试。不要通过关闭系统安全防护来解决。', settings: true };
  }
  if (/Microsoft 登录已过期|登录凭据不可用|invalid_grant|Xbox.*账户/.test(message)) {
    return { title: '账户需要重新授权', message: '登录凭据已过期或账户设置尚未完成。',
      advice: '请前往账户管理重新登录；Xbox 账户请先完成网页上的账户或家庭设置。', account: true };
  }
  if (/登录代码已过期|登录会话不存在或已过期/.test(message)) {
    return { title: '登录代码已过期', message: '浏览器授权未在有效时间内完成。',
      advice: '再次点击「Microsoft 登录」，使用新代码完成授权，旧代码已不能使用。', account: true };
  }
  if (/登录已失效|登录已过期|登录凭据不可用|grant.*expired|must sign in again|invalid_grant|AADSTS(?:700082|700084|50173)\b/i.test(message)) {
    return { title: '需要重新登录', message: '账户的登录授权已失效，暂时无法启动游戏。',
      advice: '前往「账户管理」，重新登录同一账户以更新授权。Microsoft 账户无需先删除；登录成功后再启动游戏。若反复出现，请检查系统日期、时间和时区并同步时间。', account: true };
  }
  if (/未拥有 Minecraft Java 版|没有可用的 Minecraft Java 游戏档案/.test(message)) {
    return { title: '无法使用此游戏账户', message: '此账户未拥有 Minecraft Java 版，或尚未创建 Java 版游戏档案。',
      advice: '确认登录的是拥有 Java 版的 Microsoft 账户，并在 Minecraft 官网完成游戏档案设置后重新登录。', account: true };
  }
  if (/Xbox 档案|成人验证|未成年账户|儿童账户|额外验证/.test(message)) {
    return { title: '账户需要完成设置', message,
      advice: '在 Microsoft / Xbox 官方页面完成提示的账户设置或安全验证；未成年账户请由家庭组织者处理。完成后重新登录启动器。', account: true };
  }
  if (/授权被拒绝|登录已被拒绝/.test(message)) {
    return { title: '未完成登录授权', message: 'Microsoft 登录授权被拒绝。',
      advice: '再次点击「Microsoft 登录」，在浏览器中确认账户并允许授权。', account: true };
  }
  if (/注册审核|登录配置不可用|Client ID|登录未配置/.test(message)) {
    return { title: '启动器登录配置异常', message: '启动器的 Microsoft 登录配置或应用注册需要维护者处理。',
      advice: '先更新启动器；若仍失败，请将下方错误信息反馈给启动器维护者。' };
  }
  if (/登录已失效|登录已过期|账户令牌已失效/.test(message)) {
    return { title: '需要重新登录', message: '账户的登录授权已失效，暂时无法启动游戏。',
      advice: '前往「账户管理」，重新登录 LittleSkin 账户后再启动游戏。若反复出现，请检查系统日期、时间和时区并同步时间。', account: true };
  }
  if (/连接超时|连接失败|fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(message)) {
    return { title: '无法连接服务', message: '请求未能完成，可能是网络中断、连接超时或服务暂时不可用。', advice: '检查网络连接和系统时间后重试；如使用代理，请检查代理设置。网络正常但仍失败时，请稍后再试。' };
  }
  if (/服务暂时不可用/.test(message)) {
    return { title: '登录服务暂时不可用', message, advice: '等待一段时间后重新尝试登录。' };
  }
  return { title: '操作未完成', message, advice: '请根据错误信息检查账户、网络或启动设置。若重试后仍失败，请将下方错误信息反馈给启动器维护者。' };
}

function showProblem(error, title = '操作未完成', options = {}) {
  const message = readableError(error);
  const guidance = problemGuidance(message, error?.code, options.domain);
  const dialog = document.querySelector('#problemDialog');
  document.querySelector('#problemTitle').textContent = guidance.title === '操作未完成' ? title : guidance.title;
  document.querySelector('#problemMessage').textContent = guidance.message;
  document.querySelector('#problemAdvice').textContent = guidance.advice;
  document.querySelector('#problemError').textContent = [error?.code ? `错误代码：${error.code}` : '',
    error?.phase ? `阶段：${error.phase}` : '', message].filter(Boolean).join('\n');
  document.querySelector('#problemDetails').open = false;
  document.querySelector('#problemAccountButton').hidden = !guidance.account;
  const settingsButton = document.querySelector('#problemSettingsButton');
  if (settingsButton) settingsButton.hidden = !guidance.settings;
  const javaFixButton = document.querySelector('#problemJavaFixButton');
  if (javaFixButton) {
    const majorVersion = Number.isInteger(options.javaFix) ? options.javaFix : undefined;
    javaFixButton.hidden = !Number.isInteger(majorVersion);
    javaFixButton.textContent = `下载 Java ${majorVersion} 并启动`;
    javaFixButton.onclick = majorVersion === undefined
      ? null
      : () => {
          dialog.close();
          void downloadJavaAndLaunch(majorVersion);
        };
  }
  const retryButton = document.querySelector('#problemRetryButton');
  if (retryButton) {
    retryButton.textContent = options.retryLabel ?? '重试';
    retryButton.hidden = typeof options.retry !== 'function';
    retryButton.onclick = typeof options.retry !== 'function' ? null : () => {
      dialog.close(); void options.retry();
    };
  }
  if (!dialog.open) dialog.showModal();
}

function setAccountHint(message, isError = false) {
  accountFormHint.textContent = message;
  accountFormHint.classList.toggle('is-error', isError);
}

function updateAccountCard() {
  if (accountState.current) {
    accountName.textContent = accountState.current.name;
    accountType.textContent = accountState.current.type === 'microsoft'
      ? 'Microsoft'
      : accountState.current.type === 'yggdrasil'
        ? 'LittleSkin 外置登录'
        : '离线账户';
  } else {
    accountName.textContent = '未添加账户';
    accountType.textContent = '游戏账户';
  }
  applySkinAvatar(playerAvatar, accountState.current);
}

function renderProgressBar(element, completed, total, complete = false) {
  element.max = 100;
  if (complete) {
    element.value = 100;
    return 100;
  }
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) {
    element.removeAttribute('value');
    return null;
  }
  const percent = Math.max(0, Math.min(99, Math.floor(completed / total * 100)));
  element.value = percent;
  return percent;
}

async function refreshCurrentOnlineSkin() {
  if (!['microsoft', 'yggdrasil'].includes(accountState.current?.type)
    || !accountsApi?.refreshSkin) return;
  try {
    accountState = await accountsApi.refreshSkin(accountState.current.id);
    updateAccountCard();
    renderAccountList();
  } catch (error) {
    showProblem(error);
  }
}

async function selectAccount(accountId) {
  try {
    if (accountsApi) {
      accountState = await accountsApi.select(accountId);
    } else {
      accountState.currentId = accountId;
      accountState.current = accountState.accounts.find((account) => account.id === accountId) ?? null;
    }
    updateAccountCard();
    renderAccountList();
    void refreshCurrentOnlineSkin();
    showToast(`已切换账户：${accountState.current?.name ?? '未选择'}`);
  } catch (error) {
    showProblem(error);
  }
}

async function removeAccount(accountId) {
  try {
    if (accountsApi) {
      accountState = await accountsApi.remove(accountId);
    } else {
      accountState.accounts = accountState.accounts.filter((account) => account.id !== accountId);
      accountState.currentId = accountState.accounts[0]?.id ?? null;
      accountState.current = accountState.accounts[0] ?? null;
    }
    updateAccountCard();
    renderAccountList();
    void refreshCurrentOnlineSkin();
  } catch (error) {
    showProblem(error);
  }
}

async function setAccountSkinModel(accountId, skinModel) {
  try {
    if (accountsApi?.setSkinModel) {
      accountState = await accountsApi.setSkinModel(accountId, skinModel);
    } else {
      accountState.accounts = accountState.accounts.map((account) => (
        account.id === accountId ? { ...account, skinModel } : account
      ));
      accountState.current = accountState.accounts
        .find((account) => account.id === accountState.currentId) ?? null;
    }
    updateAccountCard();
    renderAccountList();
    showToast(`默认皮肤已切换为${skinModelNames[skinModel]}`);
  } catch (error) {
    showProblem(error);
  }
}

let accountUiModule;
async function renderAccountList() {
  if (!accountDialog.open) return;
  try {
    accountUiModule ??= import('./modules/account-ui.mjs').catch((error) => {
      accountUiModule = undefined;
      throw error;
    });
    const { renderAccountList } = await accountUiModule;
    renderAccountList({ state: {
      get accountState() { return accountState; },
      set accountState(value) { accountState = value; }
    }, accountList, accountEmpty, skinUrlForAccount, applySkinAvatar, accountsApi,
      updateAccountCard, showToast, readableError, selectAccount, skinModelNames,
      setAccountSkinModel, removeAccount });
  } catch (error) {
    showToast('账户界面加载失败：' + readableError(error), true);
  }
}

async function loadAccountState({ strict = false } = {}) {
  try {
    if (accountsApi) {
      accountState = await accountsApi.getState();
      notifyStorageRecovery(accountState);
    }
    updateAccountCard();
    renderAccountList();
    void refreshCurrentOnlineSkin();
  } catch (error) {
    if (strict) throw error;
    accountName.textContent = '账户读取失败，点击管理重试';
    showToast(`账户读取失败：${readableError(error)}`);
  } finally {
    accountName.classList.remove('startup-placeholder');
    accountName.setAttribute('aria-busy', 'false');
  }
}

function applySettingsToForm() {
  wallpaperSelect.value = String(launcherSettings.wallpaperIndex ?? 3);
  selectWallpaper(Number(wallpaperSelect.value));
  selectedJavaPath = launcherSettings.javaPath ?? '';
  savedJavaRuntimes = (launcherSettings.javaRuntimes ?? []).map((entry) => ({ ...entry }));
  selectedJavaMajorVersion = savedJavaRuntimes.find((entry) => entry.path === selectedJavaPath)?.majorVersion;
  if (selectedJavaPath) rememberJavaPath(selectedJavaPath, selectedJavaMajorVersion);
  for (const entry of autoJavaDetection?.runtimes ?? []) rememberJavaPath(entry.path, entry.majorVersion);
  if (autoJavaDetection?.path) rememberJavaPath(autoJavaDetection.path, autoJavaDetection.majorVersion);
  renderJavaPathSetting();
  isolateProfilesCheck.checked = launcherSettings.isolateProfiles !== false;
  gameDirectoryModeSelect.value = launcherSettings.gameDirectoryMode ?? 'local';
  gameDirectoryHint.textContent = gameDirectoryModeSelect.value === 'local'
    ? localGameDirectoryHint
    : '使用操作系统的 Minecraft 默认游戏目录。';
  downloadSourceSelect.value = launcherSettings.downloadSource;
  downloadConcurrencySelect.value = String(launcherSettings.downloadConcurrency);
  memoryRange.value = String(launcherSettings.memoryMb);
  memoryValue.value = `${launcherSettings.memoryMb} MB`;
  autoUpdateCheck.checked = launcherSettings.autoUpdate;
  const policyOptions = ['auto', 'notify', 'off'];
  launcherUpdatePolicySelect.value = policyOptions.includes(launcherSettings.launcherUpdatePolicy)
    ? launcherSettings.launcherUpdatePolicy
    : 'auto';
  sourceHint.textContent = `${launcherSettings.downloadConcurrency} 路并发下载`;
  refreshJavaReadiness();
}

function javaOptionLabel(majorVersion, javaPath, suffix = '') {
  const versionLabel = Number.isInteger(majorVersion) ? `Java ${majorVersion} · ` : '';
  return `${versionLabel}${javaPath}${suffix}`;
}

function renderJavaPathSetting() {
  const hasCustomPath = Boolean(selectedJavaPath);
  javaBrowseButton.textContent = hasCustomPath ? '更换' : '选择';
  javaSelect.replaceChildren(new Option('按游戏版本自动选择 Java', 'auto'));
  for (const entry of savedJavaRuntimes) {
    javaSelect.add(new Option(javaOptionLabel(entry.majorVersion, entry.path), entry.path));
  }
  javaSelect.add(new Option('添加 Java 路径…', 'custom'));
  javaSelect.value = hasCustomPath ? selectedJavaPath : 'auto';
  javaSelect.title = hasCustomPath
    ? selectedJavaPath
    : autoJavaDetection?.path ?? '';
}

function rememberJavaPath(javaPath, majorVersion) {
  if (!javaPath) return;
  const entry = savedJavaRuntimes.find((runtime) => runtime.path === javaPath);
  if (entry) {
    if (Number.isInteger(majorVersion)) entry.majorVersion = majorVersion;
  } else {
    savedJavaRuntimes.push({ path: javaPath, ...(Number.isInteger(majorVersion) ? { majorVersion } : {}) });
  }
}

function applyAutoJavaDetection(result) {
  if (!result?.available || !result.path) {
    autoJavaDetection = null;
    return false;
  }
  autoJavaDetection = { path: result.path, majorVersion: result.majorVersion, runtimes: result.runtimes ?? [] };
  for (const entry of autoJavaDetection.runtimes) rememberJavaPath(entry.path, entry.majorVersion);
  rememberJavaPath(result.path, result.majorVersion);
  renderJavaPathSetting();
  javaEnvironmentKnown = true;
  refreshJavaReadiness();
  return true;
}

// 首页 Java 就绪预检：结合所选版本的 Java 需求与已检测到的运行环境
function selectedProfileJavaRequirement() {
  const targetId = versionSelect.value;
  if (!targetId) return undefined;
  const profile = localProfiles.find((entry) => (entry.targetId ?? entry.profileId) === targetId);
  const majorVersion = Number(profile?.requiredJavaVersion);
  return Number.isInteger(majorVersion) && majorVersion > 0 ? majorVersion : undefined;
}

function availableJavaMajors() {
  return new Set([
    ...(autoJavaDetection?.runtimes ?? []).map((entry) => entry.majorVersion),
    ...savedJavaRuntimes.map((entry) => entry.majorVersion)
  ].filter((majorVersion) => Number.isInteger(majorVersion)));
}

function refreshJavaReadiness() {
  const required = selectedProfileJavaRequirement();
  if (!Number.isInteger(required)) {
    javaReadiness = { status: 'idle' };
  } else if (availableJavaMajors().has(required)) {
    javaReadiness = { status: 'ready', majorVersion: required };
  } else if (javaEnvironmentKnown) {
    // 检测完成前不预告缺失，避免检测结果未到时误报
    javaReadiness = availableJavaMajors().size > 0
      ? { status: 'missing', majorVersion: required }
      : { status: 'absent', majorVersion: required };
  } else {
    javaReadiness = { status: 'idle' };
  }
  updateLaunchButtonState();
}

// 系统级 Java 检测只发起一次，多处共享结果
function detectSystemJava(force = false) {
  if (force) autoJavaDetectionPromise = null;
  if (!autoJavaDetectionPromise) {
    autoJavaDetectionPromise = (minecraft?.detectJava
      ? minecraft.detectJava({ force })
      : settingsApi.detectJava({ force }))
      .catch(() => null)
      .finally(() => { javaEnvironmentKnown = true; });
  }
  return autoJavaDetectionPromise;
}

// 自动模式下后台检测一次，让设置页直接显示实际使用的 Java 路径
async function refreshAutoJavaDetection() {
  if (!settingsApi?.detectJava) return null;
  const result = await detectSystemJava();
  if (result?.available && result.path) {
    applyAutoJavaDetection(result);
  }
  return result;
}

async function chooseJavaPath() {
  if (!settingsApi?.selectJava) {
    showToast('当前环境不支持选择 Java 路径');
    return false;
  }
  javaBrowseButton.disabled = true;
  try {
    const selection = await settingsApi.selectJava();
    if (selection.canceled) return false;
    selectedJavaPath = selection.javaPath;
    selectedJavaMajorVersion = selection.majorVersion;
    rememberJavaPath(selectedJavaPath, selectedJavaMajorVersion);
    renderJavaPathSetting();
    javaEnvironmentKnown = true;
    refreshJavaReadiness();
    showToast(`已选择 Java ${selection.majorVersion}`);
    return true;
  } catch (error) {
    showProblem(error);
    return false;
  } finally {
    javaBrowseButton.disabled = false;
  }
}

async function loadLauncherSettings({ strict = false, detectJava = true } = {}) {
  try {
    if (!launcherSettingsLoaded) {
      launcherSettingsLoadingPromise ??= Promise.resolve().then(async () => {
        if (settingsApi) launcherSettings = await settingsApi.getState();
        notifyStorageRecovery(launcherSettings);
        applySettingsToForm();
        launcherSettingsLoaded = true;
      }).finally(() => { launcherSettingsLoadingPromise = undefined; });
      await launcherSettingsLoadingPromise;
    }
    if (detectJava) void refreshAutoJavaDetection();
    return true;
  } catch (error) {
    if (strict) throw error;
    showToast(`设置读取失败：${readableError(error)}`);
    return false;
  } finally {
    sourceHint.classList.remove('startup-placeholder');
    sourceHint.setAttribute('aria-busy', 'false');
  }
}

async function addOfflineAccount() {
  const playerName = offlineNameInput.value.trim();
  const skinModel = offlineSkinModelInputs.find((input) => input.checked)?.value ?? 'steve';
  if (!/^[A-Za-z0-9_]{3,16}$/.test(playerName)) {
    setAccountHint('用户名需为 3–16 位英文字母、数字或下划线。', true);
    return;
  }

  addOfflineButton.disabled = true;
  setAccountHint('正在保存离线账户…');
  try {
    if (accountsApi) {
      accountState = await accountsApi.addOffline(playerName, skinModel);
    } else {
      const account = {
        id: `offline:preview-${playerName.toLowerCase()}`,
        type: 'offline',
        name: playerName,
        uuid: '00000000-0000-3000-8000-000000000000',
        skinModel
      };
      accountState.accounts = [
        ...accountState.accounts.filter((item) => item.name.toLowerCase() !== playerName.toLowerCase()),
        account
      ];
      accountState.currentId = account.id;
      accountState.current = account;
    }
    offlineNameInput.value = '';
    setAccountHint('离线账户已添加并设为当前账户。');
    updateAccountCard();
    renderAccountList();
    showToast(`当前账户：${accountState.current.name}`);
  } catch (error) {
    setAccountHint(readableError(error), true);
  } finally {
    addOfflineButton.disabled = false;
  }
}

function setJavaDownloadPanelOpen(open) {
  javaDownloadPanel.hidden = !open;
  javaDownloadButton.setAttribute('aria-expanded', String(open));
}

async function prepareJavaDownloadSelection(requiredMajorVersion) {
  if (javaDownloadActive) return;
  const request = ++javaRequirementRequest;
  javaDownloadVersionSelect.value = '21';
  javaDownloadHint.textContent = '';
  javaDownloadPercent.textContent = '';
  try {
    const requirement = Number.isInteger(requiredMajorVersion)
      ? { majorVersion: requiredMajorVersion }
      : versionSelect.value && minecraft?.getJavaRequirement
        ? await minecraft.getJavaRequirement(versionSelect.value)
        : null;
    if (request !== javaRequirementRequest || javaDownloadActive) return;
    if (requirement) {
      if ([8, 16, 17, 21, 25].includes(requirement.majorVersion)) {
        javaDownloadVersionSelect.value = String(requirement.majorVersion);
      }
      javaDownloadHint.textContent = `当前游戏需要 Java ${requirement.majorVersion}`;
    }
  } catch (error) {
    if (request === javaRequirementRequest) javaDownloadHint.textContent = readableError(error);
  }
}

async function ensureSettingsOpen() {
  if (settingsDialog.open) return true;
  // Share the initial read so a late response cannot replace an editable draft.
  if (!launcherSettingsLoaded && !await loadLauncherSettings()) return false;
  if (!settingsDialog.open) {
    applySettingsToForm();
    settingsDialog.returnValue = '';
    settingsDialog.showModal();
  }
  return true;
}

async function openJavaSettings(requiredMajorVersion) {
  if (!await ensureSettingsOpen()) return;
  setJavaDownloadPanelOpen(true);
  await prepareJavaDownloadSelection(requiredMajorVersion);
  javaDownloadPanel.scrollIntoView({ block: 'nearest' });
}

function renderJavaDownloadState() {
  const busy = javaDownloadActive || javaFixActive;
  javaDownloadVersionSelect.disabled = busy;
  javaDownloadStartButton.disabled = busy;
  javaDownloadStartButton.textContent = javaDownloadActive ? '下载中' : '下载';
  javaDownloadCancelButton.hidden = !javaDownloadActive;
  gameDirectoryModeSelect.disabled = busy;
  settingsDialog.querySelector('[value="save"]').disabled = busy;
}

javaDownloadButton.addEventListener('click', () => {
  setJavaDownloadPanelOpen(javaDownloadPanel.hidden);
  if (!javaDownloadPanel.hidden && !javaDownloadActive) void prepareJavaDownloadSelection();
});

javaDownloadVersionSelect.addEventListener('change', () => {
  javaRequirementRequest += 1;
});

minecraft?.onJavaDownloadProgress?.((progress) => {
  if (javaFixActive) {
    // 一键修复走首页状态条，设置面板不重复展示
    if (progress.taskId && progress.taskId !== javaFixTaskId) return;
    if (progress.cancellable === false) homeCancelDownloadButton.hidden = true;
    if (progress.message) gameStatus.textContent = progress.message;
    const percent = Number.isFinite(progress.receivedBytes) && Number.isFinite(progress.totalBytes)
      && progress.totalBytes > 0
      ? Math.max(0, Math.min(99, Math.floor(progress.receivedBytes / progress.totalBytes * 100)))
      : null;
    launchHint.textContent = `Java ${javaFixMajorVersion} · ${percent === null ? '下载中' : `${percent}%`}`;
    return;
  }
  if (!javaDownloadActive) return;
  if (progress.taskId && progress.taskId !== javaDownloadTaskId) return;
  javaDownloadHint.textContent = progress.message ?? '正在准备 Java 运行环境';
  const percent = renderProgressBar(javaDownloadProgress, progress.receivedBytes, progress.totalBytes);
  javaDownloadPercent.textContent = percent === null ? '—' : `${percent}%`;
  javaDownloadProgress.hidden = false;
  if (Number.isFinite(progress.receivedBytes)) {
    javaDownloadHint.textContent += ` · ${(progress.receivedBytes / 1048576).toFixed(1)} MB`;
  }
});

javaDownloadStartButton.addEventListener('click', async () => {
  if (javaDownloadActive || javaFixActive) return;
  if (!minecraft?.downloadJava) {
    showToast('当前环境不支持下载 Java');
    return;
  }
  if (gameDirectoryModeSelect.value !== launcherSettings.gameDirectoryMode) {
    showToast('请先保存游戏目录设置，再下载 Java');
    return;
  }
  javaRequirementRequest += 1;
  const majorVersion = Number(javaDownloadVersionSelect.value);
  javaDownloadActive = true;
  javaDownloadTaskId = crypto.randomUUID();
  javaDownloadCancelButton.disabled = false;
  javaDownloadProgress.hidden = false;
  javaDownloadProgress.removeAttribute('value');
  javaDownloadPercent.textContent = '—';
  javaDownloadHint.textContent = `正在准备 Java ${majorVersion}`;
  renderJavaDownloadState();
  try {
    const result = await minecraft.downloadJava(majorVersion, { taskId: javaDownloadTaskId });
    autoJavaDetectionPromise = null;
    rememberJavaPath(result.javaPath, majorVersion);
    renderJavaPathSetting();
    if (!selectedJavaPath) applyAutoJavaDetection({ available: true, path: result.javaPath, majorVersion });
    javaEnvironmentKnown = true;
    refreshJavaReadiness();
    javaDownloadProgress.value = 100;
    javaDownloadPercent.textContent = '100%';
    javaDownloadHint.textContent = `Java ${majorVersion} 已安装`;
    window.localStorage.setItem(JAVA_CHECK_SKIP_KEY, '1');
    showToast(`Java ${majorVersion} 运行环境已就绪`);
  } catch (error) {
    javaDownloadProgress.hidden = true;
    javaDownloadPercent.textContent = '';
    javaDownloadHint.textContent = readableError(error);
    const cancelled = error?.code === 'TASK_CANCELLED' || error?.name === 'AbortError' || javaDownloadHint.textContent === '下载已取消';
    showToast(cancelled ? javaDownloadHint.textContent : `下载失败：${javaDownloadHint.textContent}`, !cancelled);
    if (!cancelled) showProblem(error, 'Java 下载未完成', { domain: 'java' });
  } finally {
    javaDownloadActive = false;
    javaDownloadTaskId = '';
    renderJavaDownloadState();
  }
});

javaDownloadCancelButton.addEventListener('click', async () => {
  if (!javaDownloadActive) return;
  javaDownloadCancelButton.disabled = true;
  try {
    await minecraft.cancelJavaDownload();
    if (javaDownloadActive) javaDownloadHint.textContent = '正在取消下载';
  } catch (error) {
    javaDownloadCancelButton.disabled = false;
    showProblem(error);
  }
});

function setMicrosoftLoginBusy(active) {
  microsoftLoginActive = active;
  microsoftLoginButton.disabled = active;
  microsoftCancelLoginButton.disabled = !active;
}

async function copyMicrosoftDeviceCode(code = microsoftDeviceCode.textContent, notify = true) {
  const normalizedCode = String(code ?? '').trim();
  if (!/^[A-Z0-9-]{6,24}$/i.test(normalizedCode)) return false;
  try {
    await accountsApi?.copyMicrosoftCode?.(normalizedCode);
    microsoftCopyCodeButton.textContent = '已复制';
    window.setTimeout(() => {
      microsoftCopyCodeButton.textContent = '复制';
    }, 1600);
    if (notify) showToast('登录代码已复制');
    return true;
  } catch (error) {
    if (notify) showToast(readableError(error));
    return false;
  }
}

async function beginMicrosoftLogin() {
  if (microsoftLoginActive) return;
  if (!accountsApi?.beginMicrosoft || !accountsApi?.completeMicrosoft) {
    showToast('请在 Electron 启动器中使用 Microsoft 登录');
    return;
  }

  const requestId = ++microsoftLoginRequestId;
  setMicrosoftLoginBusy(true);
  microsoftDevicePanel.hidden = false;
  microsoftDeviceCode.textContent = '正在连接…';
  microsoftLoginHint.textContent = '正在向 Microsoft 申请登录代码';
  try {
    const session = await accountsApi.beginMicrosoft();
    if (requestId !== microsoftLoginRequestId) {
      await accountsApi.cancelMicrosoft?.(session.sessionId);
      return;
    }
    microsoftLoginSessionId = session.sessionId;
    microsoftDeviceCode.textContent = session.userCode;
    const copied = await copyMicrosoftDeviceCode(session.userCode, false);
    microsoftLoginHint.textContent = copied
      ? '代码已复制；授权页面完成后会自动登录'
      : '授权页面已打开，完成后会自动登录';
    const completedState = await accountsApi.completeMicrosoft(session.sessionId);
    if (requestId !== microsoftLoginRequestId) return;
    accountState = completedState;
    updateAccountCard();
    renderAccountList();
    microsoftDevicePanel.hidden = true;
    showToast(`Microsoft 登录成功：${accountState.current?.name ?? 'Minecraft 玩家'}`);
  } catch (error) {
    if (requestId !== microsoftLoginRequestId) return;
    const message = readableError(error);
    if (!message.includes('登录已取消')) {
      microsoftLoginHint.textContent = message;
      showProblem(error, 'Microsoft 登录失败');
    }
  } finally {
    if (requestId === microsoftLoginRequestId) {
      microsoftLoginSessionId = undefined;
      setMicrosoftLoginBusy(false);
    }
  }
}

async function reauthenticateExpiredMicrosoft() {
  try {
    accountState = await accountsApi.getState();
    updateAccountCard();
    renderAccountList();
    openAccountManagement();
    microsoftLoginHint.textContent = '登录已过期，正在申请新的 Microsoft 登录代码';
    void beginMicrosoftLogin();
  } catch (error) {
    showProblem(error, 'Microsoft 重新登录失败');
  }
}

async function cancelMicrosoftLogin() {
  ++microsoftLoginRequestId;
  const sessionId = microsoftLoginSessionId;
  microsoftLoginSessionId = undefined;
  if (sessionId) await accountsApi?.cancelMicrosoft?.(sessionId);
  microsoftDevicePanel.hidden = true;
  setMicrosoftLoginBusy(false);
  showToast('Microsoft 登录已取消');
}

// 启动失败后的一键修复：下载游戏所需 Java 并自动重试启动
async function downloadJavaAndLaunch(majorVersion) {
  if (!minecraft?.downloadJava) {
    void openJavaSettings(majorVersion);
    return;
  }
  if (javaFixActive || javaDownloadActive || launchRequestActive
      || versionDownloadActive || modpackInstallActive || modImportActive) {
    showToast('请先等待当前任务完成');
    return;
  }
  javaFixActive = true;
  javaFixMajorVersion = majorVersion;
  javaFixTaskId = crypto.randomUUID();
  javaFixCancelRequested = false;
  launchButton.disabled = true;
  launchLabel.textContent = '正在下载 Java';
  launchHint.textContent = `正在下载 Java ${majorVersion}`;
  gameStatus.textContent = `正在准备 Java ${majorVersion} 运行环境`;
  statusBadge.textContent = 'JAVA';
  homeCancelDownloadButton.hidden = false;
  homeCancelDownloadButton.disabled = false;
  renderJavaDownloadState();
  let launchAfterFix = false;
  try {
    const result = await minecraft.downloadJava(majorVersion, { taskId: javaFixTaskId });
    autoJavaDetectionPromise = null;
    rememberJavaPath(result.javaPath, majorVersion);
    renderJavaPathSetting();
    if (!selectedJavaPath) applyAutoJavaDetection({ available: true, path: result.javaPath, majorVersion });
    javaEnvironmentKnown = true;
    refreshJavaReadiness();
    window.localStorage.setItem(JAVA_CHECK_SKIP_KEY, '1');
    showToast(`Java ${majorVersion} 已就绪，正在启动游戏`);
    gameStatus.textContent = `Java ${majorVersion} 已就绪，正在启动游戏`;
    launchAfterFix = true;
  } catch (error) {
    const cancelled = error?.code === 'TASK_CANCELLED' || error?.name === 'AbortError';
    showToast(cancelled ? '已取消 Java 下载，可再次启动游戏重试' : `Java 下载未完成：${readableError(error)}`, !cancelled);
    if (!cancelled) {
      showProblem(error, 'Java 下载未完成', { domain: 'java', retry: () => downloadJavaAndLaunch(majorVersion) });
    }
  } finally {
    javaFixActive = false;
    javaFixTaskId = '';
    javaFixMajorVersion = undefined;
    javaFixCancelRequested = false;
    homeCancelDownloadButton.hidden = true;
    homeCancelDownloadButton.disabled = false;
    statusBadge.textContent = 'READY';
    renderJavaDownloadState();
    updateLaunchButtonState();
  }
  if (launchAfterFix) await launchSelectedVersion();
}

async function cancelJavaFixDownload() {
  if (!javaFixActive || javaFixCancelRequested) return;
  javaFixCancelRequested = true;
  homeCancelDownloadButton.disabled = true;
  launchHint.textContent = '正在取消 Java 下载…';
  try {
    await minecraft.cancelJavaDownload();
  } catch (error) {
    javaFixCancelRequested = false;
    homeCancelDownloadButton.disabled = false;
    showProblem(error);
  }
}

function setLittleSkinLoginBusy(active) {
  littleSkinLoginActive = active;
  littleSkinLoginButton.disabled = active;
  littleSkinUsernameInput.disabled = active;
  littleSkinPasswordInput.disabled = active;
  littleSkinLoginButton.textContent = active ? '正在登录…' : '登录并同步';
}

async function beginLittleSkinLogin() {
  if (littleSkinLoginActive) return;
  if (!accountsApi?.loginLittleSkin) {
    showToast('请在 Electron 启动器中使用 LittleSkin 登录');
    return;
  }

  const username = littleSkinUsernameInput.value.trim();
  const password = littleSkinPasswordInput.value;
  if (!username || !password) {
    littleSkinLoginHint.textContent = '请输入 LittleSkin 邮箱（或角色名）和密码。';
    littleSkinLoginHint.classList.add('is-error');
    return;
  }

  setLittleSkinLoginBusy(true);
  littleSkinLoginHint.classList.remove('is-error');
  littleSkinLoginHint.textContent = '正在验证账户并同步角色材质…';
  try {
    const result = await accountsApi.loginLittleSkin(username, password);
    littleSkinPasswordInput.value = '';
    accountState = result.state;
    updateAccountCard();
    renderAccountList();
    littleSkinLoginHint.textContent = `已同步角色：${accountState.current?.name ?? 'LittleSkin 玩家'}`;
    showToast(`LittleSkin 登录成功：${accountState.current?.name ?? 'Minecraft 玩家'}`);
  } catch (error) {
    const message = readableError(error);
    littleSkinLoginHint.textContent = message;
    littleSkinLoginHint.classList.add('is-error');
    showProblem(error, 'LittleSkin 登录失败');
  } finally {
    setLittleSkinLoginBusy(false);
  }
}

function selectWallpaper(index) {

  const selectedSlide = wallpaperSlides[index];
  if (selectedSlide) {
    const sceneUrl = new URL(selectedSlide.getAttribute('src'), document.baseURI).href;
    launcherApp.style.setProperty('--launcher-dialog-scene', `url("${sceneUrl}")`);
  }

  wallpaperSlides.forEach((slide, slideIndex) => {
    slide.classList.toggle('is-active', slideIndex === index);
  });

}

function fallbackVersionResult() {
  return {
    source: { id: 'preview', label: '界面预览', latency: 0 },
    versions: [
      { id: '1.21.5', type: 'release', releaseTime: '2025-03-25T00:00:00Z', installed: true },
      { id: '1.21.4', type: 'release', releaseTime: '2024-12-03T00:00:00Z', installed: false },
      { id: '1.20.1', type: 'release', releaseTime: '2023-06-12T00:00:00Z', installed: true },
      { id: '25w10a', type: 'snapshot', releaseTime: '2025-03-05T00:00:00Z', installed: false }
    ]
  };
}

function fallbackLocalVersionResult() {
  return {
    profiles: [
      {
        profileId: '1.21.5',
        type: 'release',
        loaderType: 'vanilla',
        valid: true,
        complete: true
      },
      {
        profileId: 'fabric-loader-0.16.10-1.20.1',
        type: 'release',
        inheritsFrom: '1.20.1',
        loaderType: 'fabric',
        valid: true,
        complete: true
      }
    ]
  };
}

function fallbackLoaderResult(gameVersion, loaderType) {
  const examples = {
    fabric: ['0.16.10', '0.16.9'],
    quilt: ['0.26.4'],
    forge: gameVersion === '1.20.1' ? ['47.3.22', '47.3.12'] : ['52.0.28'],
    neoforge: gameVersion === '1.20.1' ? [] : ['21.1.93', '21.1.90']
  };
  return {
    gameVersion,
    loaderType,
    versions: (examples[loaderType] ?? [gameVersion]).map((version) => ({
      version,
      stable: true,
      installed: false
    }))
  };
}

let downloadUiController;
function getDownloadUi() {
  downloadUiController ??= window.launcherUiModules.createModuleController({
    create: () => {
      const create = window.launcherUiModules.createDownloadUi;
      if (!create) throw new Error('任务进度界面组件缺失，请重新下载完整启动器');
      return create({ state: {
      get activeTaskId() { return activeTaskId; }, set activeTaskId(value) { activeTaskId = value; },
      get lastDownloadProgress() { return lastDownloadProgress; }, set lastDownloadProgress(value) { lastDownloadProgress = value; },
      get versionDownloadActive() { return versionDownloadActive; }, set versionDownloadActive(value) { versionDownloadActive = value; },
      get downloadCancellable() { return downloadCancellable; }, set downloadCancellable(value) { downloadCancellable = value; },
      get downloadCancelRequested() { return downloadCancelRequested; }, set downloadCancelRequested(value) { downloadCancelRequested = value; },
      get activeDownloadLabel() { return activeDownloadLabel; }, set activeDownloadLabel(value) { activeDownloadLabel = value; },
      get launcherSettings() { return launcherSettings; }, set launcherSettings(value) { launcherSettings = value; }
    }, sourceHint, cancelDownloadButton, homeCancelDownloadButton, taskButton, downloadStatus, downloadMessage, downloadStage, downloadProgress, downloadPercent, gameStatus, statusBadge, downloadSpeed, downloadEta, downloadSize, downloadFiles, renderProgressBar });
    },
    onError: (error) => showToast('任务进度：' + readableError(error), true)
  });
  return downloadUiController;
}

function updateDownloadProgress(progress) {
  return getDownloadUi().invoke('updateDownloadProgress', [progress]);
}

let versionCatalogUiController;
function getVersionCatalogUi() {
  versionCatalogUiController ??= window.launcherUiModules.createModuleController({
    create: () => {
      const create = window.launcherUiModules.createVersionCatalogUi;
      if (!create) throw new Error('版本管理界面组件缺失，请重新下载完整启动器');
      return create({ state: {
      get localProfiles() { return localProfiles; }, set localProfiles(value) { localProfiles = value; },
      get localProfilesLoaded() { return localProfilesLoaded; }, set localProfilesLoaded(value) { localProfilesLoaded = value; },
      get localProfilesLoadingPromise() { return localProfilesLoadingPromise; }, set localProfilesLoadingPromise(value) { localProfilesLoadingPromise = value; },
      get localProfilesLoadToken() { return localProfilesLoadToken; }, set localProfilesLoadToken(value) { localProfilesLoadToken = value; },
      get remoteVersions() { return remoteVersions; }, set remoteVersions(value) { remoteVersions = value; },
      get filteredVersions() { return filteredVersions; }, set filteredVersions(value) { filteredVersions = value; },
      get versionCatalogLoaded() { return versionCatalogLoaded; }, set versionCatalogLoaded(value) { versionCatalogLoaded = value; },
      get versionCatalogLoading() { return versionCatalogLoading; }, set versionCatalogLoading(value) { versionCatalogLoading = value; },
      get versionCatalogLoadToken() { return versionCatalogLoadToken; }, set versionCatalogLoadToken(value) { versionCatalogLoadToken = value; },
      get loaderVersions() { return loaderVersions; }, set loaderVersions(value) { loaderVersions = value; },
      get loaderCatalogLoading() { return loaderCatalogLoading; }, set loaderCatalogLoading(value) { loaderCatalogLoading = value; },
      get loaderLoadToken() { return loaderLoadToken; }, set loaderLoadToken(value) { loaderLoadToken = value; },
      get currentGameDirectory() { return currentGameDirectory; }, set currentGameDirectory(value) { currentGameDirectory = value; },
      get versionDownloadActive() { return versionDownloadActive; }, set versionDownloadActive(value) { versionDownloadActive = value; },
      get launchRequestActive() { return launchRequestActive; }, set launchRequestActive(value) { launchRequestActive = value; },
      get javaFixActive() { return javaFixActive; }, set javaFixActive(value) { javaFixActive = value; },
      get fabricApiConfirmationActive() { return fabricApiConfirmationActive; }, set fabricApiConfirmationActive(value) { fabricApiConfirmationActive = value; },
      get versionDeleteActive() { return versionDeleteActive; }, set versionDeleteActive(value) { versionDeleteActive = value; },
      get versionVerifyActive() { return versionVerifyActive; }, set versionVerifyActive(value) { versionVerifyActive = value; },
      get lastDownloadFailed() { return lastDownloadFailed; }, set lastDownloadFailed(value) { lastDownloadFailed = value; }
    },
        document, minecraft, delay, fallbackLocalVersionResult, fallbackLoaderResult, fallbackVersionResult, loaderNames, versionSelect, versionCatalog, loaderTypeSelect, loaderVersionSelect, versionSearch, versionTypeFilter, versionEmpty, versionSelectionSummary, addFabricApiButton, refreshVersionsButton, downloadVersionButton, deleteVersionButton, clearVersionSelectionButton, gameStatus, statusBadge, activeGameProfiles, rememberedSelectedGame, rememberSelectedGame, gameProcessKey, updateLaunchButtonState, refreshJavaReadiness, versionTypeName, readableError, showToast, cancelFabricApiConfirmation,
        beginRequest: (key) => getVersionCatalogUi().beginRequest(key),
        cancelRequest: (key) => getVersionCatalogUi().cancel(key),
        renderProfiles: () => renderLocalProfileOptions(),
        refreshLocalProfiles: (force) => loadLocalProfiles(force)
      });
    },
    onError: (error) => showToast('版本管理：' + readableError(error), true)
  });
  return versionCatalogUiController;
}

function selectedRemoteVersion() {
  return getVersionCatalogUi().invoke('selectedRemoteVersion');
}

function renderLocalProfileOptions() {
  return getVersionCatalogUi().invoke('renderLocalProfileOptions');
}

async function loadLocalProfiles(force = false) {
  return getVersionCatalogUi().invokeAsync('loadLocalProfiles', [force]);
}

function selectedLoaderVersion() {
  return getVersionCatalogUi().invoke('selectedLoaderVersion');
}

function renderLoaderCatalog(preferredVersion) {
  return getVersionCatalogUi().invoke('renderLoaderCatalog', [preferredVersion]);
}

async function loadLoaderCatalog(force = false) {
  return getVersionCatalogUi().invokeAsync('loadLoaderCatalog', [force]);
}

function updateVersionAction() {
  return getVersionCatalogUi().invoke('updateVersionAction');
}

function renderVersionCatalog(preferredId) {
  return getVersionCatalogUi().invoke('renderVersionCatalog', [preferredId]);
}

function invalidateVersionCatalogForDirectoryChange() {
  return getVersionCatalogUi().invoke('invalidateVersionCatalogForDirectoryChange');
}

async function reloadLocalProfilesForDirectoryChange() {
  return getVersionCatalogUi().invokeAsync('reloadLocalProfilesForDirectoryChange');
}

async function loadVersionCatalog(force = false) {
  return getVersionCatalogUi().invokeAsync('loadVersionCatalog', [force]);
}

function useVersion(profileId, displayName = profileId) {
  let option = [...versionSelect.options].find((item) => item.value === profileId);
  if (!option) {
    option = document.createElement('option');
    option.value = profileId;
    versionSelect.append(option);
  }
  option.textContent = String(displayName).replace(/^Minecraft\s+/i, '');
  versionSelect.value = profileId;
  rememberSelectedGame(profileId);
  gameStatus.textContent = `已选择 ${displayName}`;
  statusBadge.textContent = 'SELECTED';
  updateLaunchButtonState();
  updateVersionAction();
  refreshJavaReadiness();
  showToast(`已切换到 ${displayName}`);
}

function clearVersionSelection() {
  if (!versionSelect.value || versionDownloadActive || versionDeleteActive || launchRequestActive) return;
  versionSelect.value = '';
  rememberSelectedGame('');
  gameStatus.textContent = '请选择游戏版本';
  statusBadge.textContent = 'READY';
  updateLaunchButtonState();
  updateVersionAction();
  refreshJavaReadiness();
  showToast('已取消当前游戏版本选择');
}

function cancelFabricApiConfirmation() {
  fabricApiConfirmationToken += 1;
  fabricApiConfirmationActive = false;
  fabricApiUi?.cancel();
  updateVersionAction();
}

async function requestFabricApiChoice(gameVersion, loaderVersion, token, options = {}) {
  fabricApiUiModule ??= import('./modules/fabric-api-ui.mjs').then(({ createFabricApiUi }) => {
    const dialog = document.querySelector('#fabricApiDialog');
    fabricApiUi = createFabricApiUi({ minecraft, readableError, elements: {
      dialog,
      title: document.querySelector('#fabricApiTitle'),
      description: document.querySelector('#fabricApiDescription'),
      includeSetting: document.querySelector('#fabricApiIncludeSetting'),
      target: document.querySelector('#fabricApiTarget'),
      includeApi: document.querySelector('#fabricApiInclude'),
      versionSelect: document.querySelector('#fabricApiVersionSelect'),
      status: document.querySelector('#fabricApiStatus'),
      retryButton: document.querySelector('#fabricApiRetryButton'),
      installButton: document.querySelector('#fabricApiInstallButton'),
      skipButton: document.querySelector('#fabricApiSkipButton'),
      cancelButtons: [...dialog.querySelectorAll('[data-fabric-api-cancel]')]
    } });
    return fabricApiUi;
  }).catch((error) => { fabricApiUiModule = undefined; throw error; });
  const ui = await fabricApiUiModule;
  if (token !== fabricApiConfirmationToken) return null;
  return ui.confirm({ gameVersion, loaderVersion, apiOnly: options.apiOnly === true });
}

async function installSelectedVersion() {
  return installVersionSelection();
}

async function addSelectedFabricApi() {
  if (loaderTypeSelect.value !== 'fabric') return;
  return installVersionSelection({ apiOnly: selectedLoaderVersion()?.installed === true });
}

async function installVersionSelection({ apiOnly = false } = {}) {
  const version = selectedRemoteVersion();
  const loaderType = loaderTypeSelect.value;
  const loader = selectedLoaderVersion();
  if (!version || !loader || versionDownloadActive || fabricApiConfirmationActive) {
    return;
  }
  if (apiOnly && (loaderType !== 'fabric' || !loader.installed || !loader.profileId)) return;

  const loaderLabel = loaderType === 'vanilla'
    ? `Minecraft ${version.id}`
    : `Minecraft ${version.id} · ${loaderNames[loaderType]} ${loader.version}`;

  if (loader.installed && !apiOnly) {
    useVersion(loader.profileId ?? version.id, loaderLabel);
    versionDialog.close();
    return;
  }

  const expectedGameDirectory = currentGameDirectory;
  const expectedProfileId = loader.profileId;
  const directoryMode = launcherSettings.gameDirectoryMode;
  const isolateProfiles = launcherSettings.isolateProfiles;
  let fabricApiVersionId;
  if (loaderType === 'fabric') {
    const token = ++fabricApiConfirmationToken;
    fabricApiConfirmationActive = true;
    updateVersionAction();
    try {
      const choice = await requestFabricApiChoice(version.id, loader.version, token, { apiOnly });
      if (!choice || token !== fabricApiConfirmationToken || versionDownloadActive
        || selectedRemoteVersion()?.id !== version.id || loaderTypeSelect.value !== loaderType
        || selectedLoaderVersion()?.version !== loader.version
        || (apiOnly && selectedLoaderVersion()?.profileId !== expectedProfileId)
        || currentGameDirectory !== expectedGameDirectory || launcherSettings.gameDirectoryMode !== directoryMode
        || launcherSettings.isolateProfiles !== isolateProfiles) return;
      fabricApiVersionId = choice.fabricApiVersionId;
      if (apiOnly && !fabricApiVersionId) return;
    } catch (error) {
      if (token === fabricApiConfirmationToken) showProblem(error, 'Fabric 安装尚未开始',
        { retry: () => installVersionSelection({ apiOnly }) });
      return;
    } finally {
      if (token === fabricApiConfirmationToken) {
        fabricApiConfirmationActive = false;
        updateVersionAction();
      }
    }
  }

  versionDownloadActive = true;
  activeTaskId = crypto.randomUUID();
  downloadCancellable = true;
  downloadCancelRequested = false;
  lastDownloadFailed = false;
  activeDownloadLabel = apiOnly ? `Minecraft ${version.id} · Fabric API` : loaderLabel;
  updateVersionAction();
  homeStatus.hidden = false;
  versionCatalog.disabled = true;
  versionSearch.disabled = true;
  versionTypeFilter.disabled = true;
  refreshVersionsButton.disabled = true;
  deleteVersionButton.disabled = true;
  downloadVersionButton.disabled = true;
  cancelDownloadButton.hidden = false;
  cancelDownloadButton.disabled = false;
  downloadStatus.hidden = false;
  updateDownloadProgress({ phase: 'preparing', message: `正在准备 ${activeDownloadLabel}…` });
  gameStatus.textContent = `正在安装 ${activeDownloadLabel}`;
  statusBadge.textContent = 'DOWNLOAD';

  try {
    let result;
    if (apiOnly) {
      if (!minecraft?.installFabricApi) throw new Error('当前环境不支持单独添加 Fabric API，请重新打开启动器');
      result = await minecraft.installFabricApi({ taskId: activeTaskId, gameVersion: version.id,
        profileId: loader.profileId, fabricApiVersionId,
        ...(expectedGameDirectory ? { expectedGameDirectory } : {}) });
    } else if (minecraft?.installLoader) {
      result = await minecraft.installLoader({
        taskId: activeTaskId,
        gameVersion: version.id,
        loaderType,
        loaderVersion: loader.version,
        ...(expectedGameDirectory ? { expectedGameDirectory } : {}),
        ...(loaderType === 'fabric' ? { fabricApiVersionId } : {})
      });
    } else {
      for (let completedFiles = 0; completedFiles <= 20; completedFiles += 1) {
        if (downloadCancelRequested) throw new Error('下载已取消');
        updateDownloadProgress({
          phase: completedFiles === 20 ? 'complete' : 'downloading',
          message: `正在下载预览文件 ${completedFiles}/20`,
          completedFiles,
          totalFiles: 20
        });
        await delay(35);
      }
      result = { profileId: loaderType === 'vanilla' ? version.id : `${version.id}-${loaderType}-${loader.version}` };
    }

    if (!apiOnly) version.installed = true;
    loader.installed = true;
    loader.profileId = result.profileId;
    renderVersionCatalog(version.id);
    renderLoaderCatalog(loader.version);
    useVersion(result.profileId ?? version.id, loaderLabel);
    const apiLabel = result.fabricApi?.version ? ` + Fabric API ${result.fabricApi.version}` : '';
    updateDownloadProgress({ phase: 'complete', message: apiOnly
      ? `Fabric API ${result.fabricApi?.version ?? ''} 已添加到 Minecraft ${version.id}`
      : `${loaderLabel}${apiLabel} 安装完成` });
    if (result.fabricApi?.cleanupWarning) showToast(result.fabricApi.cleanupWarning, true);
    statusBadge.textContent = 'READY';
  } catch (error) {
    const message = readableError(error);
    const cancelled = error?.code === 'TASK_CANCELLED' || error?.name === 'AbortError' || message === '下载已取消';
    updateDownloadProgress({ phase: cancelled ? 'cancelled' : 'failed',
      message: cancelled ? '下载已取消，已校验文件可在下次安装时复用'
        : `下载失败：${message}。${apiOnly ? '可点击「添加 Fabric API」重试。' : '可重新点击「重试」再次下载。'}` });
    if (!downloadProgress.hasAttribute('value')) downloadProgress.value = 0;
    downloadStage.textContent = cancelled ? '已取消' : '下载失败';
    downloadPercent.textContent = cancelled ? '—' : downloadPercent.textContent;
    statusBadge.textContent = cancelled ? 'READY' : 'ERROR';
    gameStatus.textContent = cancelled ? '下载已取消' : '下载失败，可重试';
    if (!cancelled) {
      lastDownloadFailed = true;
      showToast(`下载失败：${message}，可${apiOnly ? '重新添加 Fabric API' : '点击「重试」重新下载'}`, true);
      showProblem(error, apiOnly ? 'Fabric API 添加未完成' : '游戏安装未完成',
        { retry: () => installVersionSelection({ apiOnly }) });
    } else {
      showToast('已取消下载，可重新安装');
    }
  } finally {
    versionDownloadActive = false;
    activeTaskId = '';
    downloadCancellable = true;
    homeCancelDownloadButton.hidden = true;
    taskButton.hidden = true;
    homeStatus.hidden = false;
    downloadCancelRequested = false;
    cancelDownloadButton.hidden = true;
    cancelDownloadButton.disabled = false;
    versionCatalog.disabled = false;
    versionSearch.disabled = false;
    versionTypeFilter.disabled = false;
    refreshVersionsButton.disabled = false;
    versionCloseButtons.forEach((button) => { button.disabled = false; });
    updateVersionAction();
  }
}

async function deleteSelectedVersion() {
  const version = selectedRemoteVersion();
  const loaderType = loaderTypeSelect.value;
  const loader = selectedLoaderVersion();
  const profileId = loader?.profileId;
  if (!version || !loader?.installed || !profileId || versionDownloadActive || versionDeleteActive) {
    return;
  }

  const displayName = loaderType === 'vanilla'
    ? `Minecraft ${version.id}`
    : `Minecraft ${version.id} · ${loaderNames[loaderType]} ${loader.version}`;
  const confirmed = window.confirm(
    `确定删除 ${displayName}？\n\n版本目录会移到系统回收站，共享依赖库和资源不会删除。`
  );
  if (!confirmed) return;

  versionDeleteActive = true;
  deleteVersionButton.disabled = true;
  downloadVersionButton.disabled = true;
  refreshVersionsButton.disabled = true;
  versionCloseButtons.forEach((button) => { button.disabled = true; });
  versionEmpty.textContent = `正在删除 ${displayName}…`;

  try {
    if (minecraft?.deleteVersion) {
      await minecraft.deleteVersion(profileId);
    } else {
      await delay(180);
    }

    localProfiles = localProfiles.filter((profile) => profile.profileId !== profileId);
    if (loader.localOnly) loaderVersions = loaderVersions.filter((item) => item !== loader);
    loader.installed = false;
    loader.profileId = undefined;
    if (loaderType === 'vanilla') version.installed = false;
    const activeOption = [...versionSelect.options].find((option) => option.value === profileId);
    activeOption?.remove();
    if (!versionSelect.value) {
      gameStatus.textContent = '请选择游戏版本';
      statusBadge.textContent = 'READY';
      updateLaunchButtonState();
    }
    renderVersionCatalog(version.id);
    renderLoaderCatalog(loader.version);
    gameStatus.textContent = `${displayName} 已删除`;
    statusBadge.textContent = 'READY';
    showToast('版本已移到系统回收站');
  } catch (error) {
    const message = readableError(error);
    versionEmpty.textContent = `删除失败：${message}`;
    showToast(message);
  } finally {
    versionDeleteActive = false;
    refreshVersionsButton.disabled = false;
    versionCloseButtons.forEach((button) => { button.disabled = false; });
    updateVersionAction();
  }
}

wallpaperSelect.addEventListener('change', () => selectWallpaper(Number(wallpaperSelect.value)));

document.querySelector('#minimizeButton').addEventListener('click', () => {
  windowControls?.minimize();
});

document.querySelector('#closeButton').addEventListener('click', () => {
  windowControls?.close();
});

function openAccountManagement() {
  if (!accountDialog.open) accountDialog.showModal();
  void renderAccountList();
  void loadAccountState();
  microsoftLoginButton.focus();
}

accountButton.addEventListener('click', openAccountManagement);
document.querySelector('#problemAccountButton').addEventListener('click', () => {
  document.querySelector('#problemDialog').close();
  openAccountManagement();
});

document.querySelector('#problemSettingsButton').addEventListener('click', () => {
  document.querySelector('#problemDialog').close();
  void openJavaSettings();
});
document.querySelector('#problemCopyButton').addEventListener('click', async () => {
  try {
    await environment?.diagnostics?.copyError?.(document.querySelector('#problemError').textContent);
    showToast('已复制脱敏后的错误详情');
  } catch (error) { showToast(`复制失败：${readableError(error)}`, true); }
});
document.querySelector('#problemExportReportButton').addEventListener('click', async (event) => {
  if (!environment?.diagnostics?.exportReport) {
    showToast('当前环境不支持导出诊断报告', true);
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await environment.diagnostics.exportReport(document.querySelector('#problemError').textContent);
    if (!result.canceled) showToast(`诊断报告已保存：${result.filePath}`);
  } catch (error) {
    showToast(`导出失败：${readableError(error)}`, true);
  } finally { button.disabled = false; }
});

function openActiveTask() {
  if (!versionDialog.open) versionDialog.showModal();
  downloadStatus.scrollIntoView?.({ block: 'nearest' });
}
taskButton.addEventListener('click', openActiveTask);
homeCancelDownloadButton.addEventListener('click', () => {
  if (javaFixActive) {
    void cancelJavaFixDownload();
    return;
  }
  cancelDownloadButton.click();
});
retryTaskButton.addEventListener('click', () => { void withModpackUi((ui) => ui.retry()); });

addOfflineButton.addEventListener('click', addOfflineAccount);
offlineNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addOfflineAccount();
  }
});

littleSkinLoginButton.addEventListener('click', beginLittleSkinLogin);
microsoftLoginButton.addEventListener('click', beginMicrosoftLogin);
microsoftCopyCodeButton.addEventListener('click', () => copyMicrosoftDeviceCode());
microsoftCancelLoginButton.addEventListener('click', cancelMicrosoftLogin);
accountsApi?.onMicrosoftProgress?.((progress) => {
  if (!microsoftLoginActive || progress?.sessionId !== microsoftLoginSessionId) return;
  if (progress.message) microsoftLoginHint.textContent = progress.message;
});
document.querySelector('#settingsButton').addEventListener('click', async () => {
  if (!await ensureSettingsOpen()) return;
  void prepareJavaDownloadSelection();
});

updateStatusBadge.addEventListener('click', () => {
  void handleLauncherUpdateFromBadge();
});

updateStatusBadge.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void handleLauncherUpdateFromBadge();
  }
});

launcherUpdateButton.addEventListener('click', handleLauncherUpdate);
updaterApi?.onState?.((state) => renderLauncherUpdate(state));
updaterApi?.onRequestShowSettings?.(() => {
  void openLauncherUpdateSettings();
});

document.querySelector('#versionButton').addEventListener('click', () => {
  versionDialog.showModal();
  if (!versionCatalogLoaded) {
    loadVersionCatalog();
  }
  // 下载进行中时，恢复对话框内的进度显示
  if (versionDownloadActive && lastDownloadProgress) {
    updateDownloadProgress(lastDownloadProgress);
  }
});

settingsDialog.addEventListener('close', async () => {
  const saveRequested = settingsDialog.returnValue === 'save';
  settingsDialog.returnValue = '';
  if (saveRequested) {
    try {
      const previousDirectoryMode = launcherSettings.gameDirectoryMode ?? 'local';
      const previousIsolation = launcherSettings.isolateProfiles;
      const patch = {
        wallpaperIndex: Number(wallpaperSelect.value),
        javaPath: selectedJavaPath,
        javaRuntimes: savedJavaRuntimes,
        gameDirectoryMode: gameDirectoryModeSelect.value,
        isolateProfiles: isolateProfilesCheck.checked,
        downloadSource: downloadSourceSelect.value,
        downloadConcurrency: Number(downloadConcurrencySelect.value),
        memoryMb: Number(memoryRange.value),
        autoUpdate: autoUpdateCheck.checked,
        launcherUpdatePolicy: launcherUpdatePolicySelect.value
      };
      launcherSettings = settingsApi ? await settingsApi.update(patch) : patch;
      applySettingsToForm();
      if (launcherSettings.isolateProfiles !== previousIsolation) cancelFabricApiConfirmation();
      if (launcherSettings.gameDirectoryMode !== previousDirectoryMode) {
        autoJavaDetection = null;
        autoJavaDetectionPromise = null;
        renderJavaPathSetting();
        void refreshAutoJavaDetection();
        invalidateVersionCatalogForDirectoryChange();
        if (modpackUiModule) void withModpackUi((ui) => ui.directoryChanged());
        void reloadLocalProfilesForDirectoryChange().catch((error) => {
          showToast(`游戏列表读取失败，可在「切换版本」中重试：${readableError(error)}`, true);
        });
      }
      const sourceLabel = {
        auto: '自动选择',
        bmclapi: 'BMCLAPI',
        official: 'Mojang 官方'
      }[launcherSettings.downloadSource];
      const directoryLabel = launcherSettings.gameDirectoryMode === 'local' ? '本地目录' : '系统目录';
      showToast(`设置已保存：${directoryLabel} · ${sourceLabel} · ${launcherSettings.downloadConcurrency} 路线程`);
    } catch (error) {
      applySettingsToForm();
      showToast(`设置保存失败：${readableError(error)}`);
    }
  } else {
    applySettingsToForm();
  }
});

gameDirectoryModeSelect.addEventListener('change', () => {
  gameDirectoryHint.textContent = gameDirectoryModeSelect.value === 'local'
    ? localGameDirectoryHint
    : '使用操作系统的 Minecraft 默认游戏目录。';
});

// 赞助支持链接交给系统浏览器打开，避免替换掉启动器窗口内的界面。
document.addEventListener('click', (event) => {
  const link = event.target?.closest?.('.sponsor-support-setting a[href]');
  if (!link) return;
  event.preventDefault();
  void environment?.shell?.openExternal(link.href);
});

javaSelect.addEventListener('change', async () => {
  if (javaSelect.value === 'auto') {
    selectedJavaPath = '';
    selectedJavaMajorVersion = undefined;
    renderJavaPathSetting();
    return;
  }
  if (javaSelect.value === 'custom') {
    if (!await chooseJavaPath()) renderJavaPathSetting();
    return;
  }
  selectedJavaPath = javaSelect.value;
  selectedJavaMajorVersion = savedJavaRuntimes.find((entry) => entry.path === selectedJavaPath)?.majorVersion;
  renderJavaPathSetting();
});

javaBrowseButton.addEventListener('click', () => {
  void chooseJavaPath();
});

javaRedetectButton.addEventListener('click', async () => {
  if (!settingsApi?.detectJava) return;
  javaRedetectButton.disabled = true;
  showToast('正在重新检测 Java…');
  autoJavaDetectionPromise = null;
  try {
    const result = await detectSystemJava(true);
    if (result?.available) {
      window.localStorage.setItem(JAVA_CHECK_SKIP_KEY, '1');
      selectedJavaPath = '';
      selectedJavaMajorVersion = undefined;
      applyAutoJavaDetection(result);
      showToast(`已检测到 Java ${result.majorVersion}`);
    } else {
      autoJavaDetection = null;
      renderJavaPathSetting();
      javaEnvironmentKnown = true;
      refreshJavaReadiness();
      window.localStorage.removeItem(JAVA_CHECK_SKIP_KEY);
      showToast('未检测到 Java，可手动选择路径或安装后重新检测');
    }
  } catch (error) {
    showProblem(error);
  } finally {
    javaRedetectButton.disabled = false;
  }
});

versionDialog.addEventListener('cancel', (event) => {
  if (versionDownloadActive) {
    // 不阻止关闭：下载在后台继续，可通过「切换版本」返回查看进度
    showToast('下载将在后台继续，点击「切换版本」可返回查看');
    return;
  }
  if (versionDeleteActive) {
    event.preventDefault();
  }
});
versionDialog.addEventListener('close', cancelFabricApiConfirmation);

memoryRange.addEventListener('input', () => {
  memoryValue.value = `${memoryRange.value} MB`;
});

function filterVersionCatalog() {
  const previousVersion = versionCatalog.value;
  renderVersionCatalog();
  if (versionCatalog.value !== previousVersion) {
    cancelFabricApiConfirmation();
    loadLoaderCatalog();
  }
}

versionSearch.addEventListener('input', filterVersionCatalog);
versionTypeFilter.addEventListener('change', filterVersionCatalog);
versionCatalog.addEventListener('change', () => { cancelFabricApiConfirmation(); lastDownloadFailed = false; loadLoaderCatalog(); });
loaderTypeSelect.addEventListener('change', () => { cancelFabricApiConfirmation(); lastDownloadFailed = false; loadLoaderCatalog(); });
loaderVersionSelect.addEventListener('change', () => { cancelFabricApiConfirmation(); lastDownloadFailed = false; updateVersionAction(); });
refreshVersionsButton.addEventListener('click', () => loadVersionCatalog(true));
deleteVersionButton.addEventListener('click', deleteSelectedVersion);
clearVersionSelectionButton.addEventListener('click', clearVersionSelection);
downloadVersionButton.addEventListener('click', installSelectedVersion);
addFabricApiButton.addEventListener('click', addSelectedFabricApi);
cancelDownloadButton.addEventListener('click', async () => {
  if (!versionDownloadActive || downloadCancelRequested || !downloadCancellable) return;
  downloadCancelRequested = true;
  cancelDownloadButton.disabled = true;
  downloadMessage.textContent = '正在取消下载并清理临时文件…';
  statusBadge.textContent = 'CANCEL';
  try {
    const result = await minecraft?.cancelDownload?.({ taskId: activeTaskId });
    if (result?.committing || result?.cancelled === 0) {
      downloadCancelRequested = false;
      downloadCancellable = !result.committing;
      cancelDownloadButton.disabled = Boolean(result.committing);
      homeCancelDownloadButton.hidden = Boolean(result.committing);
      downloadMessage.textContent = result.committing ? '正在保存实例，完成后即可使用' : '任务正在结束，请稍候…';
    }
  } catch (error) {
    downloadCancelRequested = false;
    cancelDownloadButton.disabled = false;
    showProblem(error);
  }
});

if (minecraft?.onDownloadProgress) {
  minecraft.onDownloadProgress(updateDownloadProgress);
}

if (minecraft?.onVerifyProgress) {
  minecraft.onVerifyProgress((progress) => {
    if (!versionVerifyActive) return;
    const total = progress.totalFiles ?? 0;
    const checked = progress.checkedFiles ?? 0;
    const percent = total > 0 ? Math.round((checked / total) * 100) : 0;
    versionEmpty.textContent = `正在检测文件 ${checked}/${total}（${percent}%）`;
  });
}

function updateLaunchButtonState() {
  const selectedProfile = versionSelect.value;
  if (launchRequestActive || javaFixActive) return;
  if (selectedProfile && activeGameProfiles.has(gameProcessKey(selectedProfile))) {
    launchButton.disabled = true;
    launchButton.classList.remove('is-launching');
    launchLabel.textContent = '游戏运行中';
    launchHint.textContent = '等待游戏进程退出';
    return;
  }
  launchButton.disabled = false;
  launchButton.classList.remove('is-launching');
  launchLabel.textContent = '启动游戏';
  if (!selectedProfile) {
    launchHint.textContent = '请先选择已安装版本';
    return;
  }
  if (javaReadiness?.status === 'ready') {
    launchHint.textContent = `Java ${javaReadiness.majorVersion} 已就绪`;
  } else if (javaReadiness?.status === 'missing') {
    launchHint.textContent = `缺少 Java ${javaReadiness.majorVersion} · 可一键下载并启动`;
  } else if (javaReadiness?.status === 'absent') {
    launchHint.textContent = '未检测到 Java · 可一键下载并启动';
  } else {
    launchHint.textContent = '准备进入方块世界';
  }
}

if (minecraft?.onLaunchStatus) {
  minecraft.onLaunchStatus((status) => {
    const launchTargetId = status.targetId ?? status.profileId;
    const processKey = gameProcessKey(launchTargetId, status.gameDirectory ?? currentGameDirectory);
    if (status.phase === 'running') activeGameProfiles.add(processKey);
    if (status.phase === 'exited') activeGameProfiles.delete(processKey);
    if (status.gameDirectory && gameProcessKey('', status.gameDirectory) !== gameProcessKey('')) return;
    if (status.phase === 'running') {
      if (versionSelect.value === launchTargetId) {
        gameStatus.textContent = `${launchTargetId} 正在运行`;
        gameStatus.title = status.logPath ? `游戏日志：${status.logPath}` : '';
        statusBadge.textContent = 'RUNNING';
      }
    } else if (status.phase === 'verifying' || status.phase === 'java' || status.phase === 'launching') {
      if (versionSelect.value === launchTargetId) {
        gameStatus.textContent = status.message ?? `使用 Java ${status.requiredJavaVersion} 启动游戏`;
        gameStatus.title = status.javaPath ?? '';
      }
    } else if (status.phase === 'authlib-injector') {
      if (versionSelect.value === launchTargetId) {
        gameStatus.textContent = status.message ?? '正在准备 LittleSkin 登录组件';
        statusBadge.textContent = 'YGGDRASIL';
        launchHint.textContent = '校验 authlib-injector';
      }
    } else if (status.phase === 'exited') {
      if (versionSelect.value === launchTargetId) {
        const normalExit = status.code === 0;
        gameStatus.textContent = normalExit
          ? `${launchTargetId} 已退出`
          : `${launchTargetId} 异常退出（${status.code ?? status.signal ?? '未知'}）`;
        gameStatus.title = status.logPath ? `游戏日志：${status.logPath}` : '';
        statusBadge.textContent = normalExit ? 'READY' : 'ERROR';
        if (normalExit) showToast('游戏已退出');
        else {
          const detail = status.logError
            ? `游戏日志保存失败（${status.logError}）`
            : status.logPath ? `游戏日志：${status.logPath}` : '游戏日志不可用';
          showProblem(new Error(`${gameStatus.textContent}\n${detail}`), '游戏异常退出');
        }
      }
    }
    updateLaunchButtonState();
  });
}

let modpackUiModule;
async function confirmModpack(info) {
  const dialog = document.querySelector('#modpackConfirmDialog');
  document.querySelector('#modpackConfirmTitle').textContent = info.name;
  const optionalCount = Number(info.optionalFileCount ?? 0);
  document.querySelector('#modpackConfirmSummary').textContent = [
    `${info.format === 'modrinth' ? 'Modrinth' : 'CurseForge'} · Minecraft ${info.gameVersion}`,
    `${loaderNames[info.loaderType] ?? info.loaderType} ${info.loaderVersion ?? ''}`,
    `必需文件 ${info.requiredFileCount ?? info.fileCount ?? 0} 个，可选文件 ${optionalCount} 个。`
  ].join('\n');
  const optionalFiles = document.querySelector('#modpackOptionalFiles');
  optionalFiles.checked = false;
  document.querySelector('#modpackOptionalSetting').hidden = optionalCount === 0;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'install'
      ? { installOptionalFiles: optionalCount > 0 && optionalFiles.checked } : null), { once: true });
    dialog.showModal();
  });
}

async function withModpackUi(callback) {
  try {
    modpackUiModule ??= import('./modules/modpack-ui.mjs').then(({ createModpackUi }) => createModpackUi({ state: {
      get versionDownloadActive() { return versionDownloadActive; },
      set versionDownloadActive(value) { versionDownloadActive = value; },
      get modpackInstallActive() { return modpackInstallActive; },
      set modpackInstallActive(value) { modpackInstallActive = value; },
      get downloadCancelRequested() { return downloadCancelRequested; },
      set downloadCancelRequested(value) { downloadCancelRequested = value; },
      get activeDownloadLabel() { return activeDownloadLabel; },
      set activeDownloadLabel(value) { activeDownloadLabel = value; },
      get activeTaskId() { return activeTaskId; },
      set activeTaskId(value) { activeTaskId = value; },
      get downloadCancellable() { return downloadCancellable; },
      set downloadCancellable(value) { downloadCancellable = value; }
    }, showToast, showProblem, minecraft, loaderNames, cancelDownloadButton, downloadStatus, gameStatus,
      statusBadge, updateDownloadProgress, updateVersionAction, delay, loadLocalProfiles,
      useVersion, readableError, confirmPack: confirmModpack, newTaskId: () => crypto.randomUUID(),
      openTask: openActiveTask, openExternal: (url) => environment?.shell?.openExternal(url),
      updateTaskEntry: ({ visible, retry }) => {
        taskButton.hidden = !visible;
        retryTaskButton.hidden = !retry;
        homeCancelDownloadButton.hidden = !versionDownloadActive || !downloadCancellable;
      }, elements: {
        recoveryPanel: document.querySelector('#modpackRecoveryPanel'),
        recoveryTitle: document.querySelector('#modpackRecoveryTitle'),
        missingFiles: document.querySelector('#modpackMissingFiles'),
        resumeButton: document.querySelector('#modpackResumeButton'),
        discardButton: document.querySelector('#modpackDiscardButton')
      }
    })).catch((error) => {
      modpackUiModule = undefined;
      throw error;
    });
    return await callback(await modpackUiModule);
  } catch (error) {
    showToast('整合包界面加载失败：' + readableError(error), true);
  }
}

async function installDroppedModpack(filePath) {
  return withModpackUi((ui) => ui.install(filePath));
}

let modpackDragDepth = 0;
document.addEventListener('dragenter', (event) => {
  if (!document.querySelector('#startupScreen').hidden) return;
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  modpackDragDepth += 1;
  modpackDropOverlay.hidden = false;
});

document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  modpackDragDepth = Math.max(0, modpackDragDepth - 1);
  if (modpackDragDepth === 0) modpackDropOverlay.hidden = true;
});

let modImportActive = false;
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  if (!document.querySelector('#startupScreen').hidden) return;
  modpackDragDepth = 0;
  modpackDropOverlay.hidden = true;
  const files = Array.from(event.dataTransfer?.files ?? []);
  const paths = files.map(file => filesApi?.getPath?.(file));
  if (!paths.length || paths.some(filePath => !filePath || !/\.(jar|mrpack|zip)$/i.test(filePath))) {
    showToast('请拖入 Mod .jar，或 Modrinth .mrpack / CurseForge .zip 整合包');
    return;
  }
  if (modImportActive || versionDownloadActive || modpackInstallActive || launchRequestActive || javaFixActive) {
    showToast('请先等待当前任务完成后再导入');
    return;
  }
  if (paths.some(filePath => /\.(mrpack|zip)$/i.test(filePath))) {
    if (paths.length !== 1) { showToast('整合包请一次拖入一个；多个 Mod 可以一起拖入'); return; }
    await installDroppedModpack(paths[0]);
    return;
  }
  const targetId = versionSelect.value;
  if (!targetId) { showToast('请先在游戏列表中选择已安装的游戏，再拖入 Mod'); return; }
  if (!minecraft?.importModFile) { showToast('Mod 导入需在启动器应用中使用'); return; }
  modImportActive = true;
  let imported = 0;
  const failures = [];
  try {
    showToast(`正在导入 ${paths.length} 个 Mod…`);
    for (const filePath of paths) {
      try { await minecraft.importModFile(targetId, filePath); imported++; }
      catch (error) { failures.push(readableError(error)); }
    }
    showToast(failures.length
      ? `已导入 ${imported} 个 Mod，${failures.length} 个失败：${failures[0]}`
      : `已将 ${imported} 个 Mod 导入当前游戏，启动游戏后生效`, failures.length > 0);
  } finally { modImportActive = false; }
});

launchButton.addEventListener('click', () => {
  void launchSelectedVersion();
});

async function repairSelectedVersion(profileId, directory = currentGameDirectory) {
  if (!minecraft?.repairVersion || launchRequestActive) return;
  if (gameProcessKey('', directory) !== gameProcessKey('')) {
    showToast('游戏目录已改变，请切回原目录后补全文件', true);
    return;
  }
  launchRequestActive = true;
  launchButton.disabled = true;
  launchLabel.textContent = '正在补全文件';
  launchHint.textContent = '保留存档、Mod 和实例配置';
  try {
    await minecraft.repairVersion(profileId);
    if (gameProcessKey('', directory) !== gameProcessKey('')) return;
    await loadLocalProfiles(true);
    if ([...versionSelect.options].some((option) => option.value === profileId)) versionSelect.value = profileId;
  } catch (error) {
    if (gameProcessKey('', directory) === gameProcessKey('')) {
      showProblem(error, '游戏文件补全失败', { retry: () => repairSelectedVersion(profileId, directory) });
    }
    return;
  } finally {
    launchRequestActive = false;
    updateLaunchButtonState();
  }
  if (versionSelect.value === profileId) await launchSelectedVersion();
}

async function launchSelectedVersion() {
  if (launchRequestActive) return;
  if (!versionSelect.value) {
    gameStatus.textContent = '请先安装并选择游戏版本';
    statusBadge.textContent = 'READY';
    launchHint.textContent = '请先选择已安装版本';
    showToast('请先安装并选择一个完整的游戏版本', true);
    return;
  }
  if (!accountState.current) {
    gameStatus.textContent = '请先添加并选择游戏账户';
    statusBadge.textContent = 'READY';
    launchHint.textContent = '请先添加游戏账户';
    showToast('请先添加并选择一个游戏账户', true);
    return;
  }
  const profileId = versionSelect.value;
  const launchDirectory = currentGameDirectory;
  launchRequestActive = true;
  launchButton.disabled = true;
  launchButton.classList.add('is-launching');
  launchLabel.textContent = '正在准备';
  launchHint.textContent = '检查 Java 与游戏文件';
  gameStatus.textContent = `正在准备 ${profileId}`;
  statusBadge.textContent = 'STARTING';
  updateVersionAction();

  try {
    const result = minecraft?.launchVersion
      ? await minecraft.launchVersion(profileId)
      : await delay(300).then(() => {
        activeGameProfiles.add(gameProcessKey(profileId));
        gameStatus.textContent = `${profileId} 正在运行`;
        statusBadge.textContent = 'RUNNING';
        return { profileId, pid: 0 };
      });
    showToast(result.pid ? `游戏已启动（PID ${result.pid}）` : '游戏启动参数已生成');
  } catch (error) {
    if (gameProcessKey('', launchDirectory) !== gameProcessKey('')) return;
    const message = readableError(error);
    gameStatus.textContent = '游戏启动失败';
    statusBadge.textContent = 'ERROR';
    const requiredJava = message.match(/需要 Java (\d+)/);
    if (/Microsoft 登录已过期，已自动退出/.test(message)) {
      await reauthenticateExpiredMicrosoft();
    } else if (requiredJava && minecraft?.downloadJava) {
      // 缺少所需 Java：提供一键下载并自动重试，而不是只给一条错误信息
      showProblem(error, '游戏启动失败', { javaFix: Number(requiredJava[1]) });
    } else if (requiredJava) {
      showToast(message, true);
      void openJavaSettings(Number(requiredJava[1]));
    } else if ((error.code === 'GAME_FILES_INCOMPLETE' || /游戏文件不完整/.test(message)) && minecraft?.repairVersion) {
      showProblem(error, '游戏文件需要补全', {
        retryLabel: '补全文件并启动', retry: () => repairSelectedVersion(profileId, launchDirectory)
      });
    } else {
      showProblem(error, '游戏启动失败');
    }
  } finally {
    launchRequestActive = false;
    updateLaunchButtonState();
    updateVersionAction();
  }
}

versionSelect.addEventListener('change', () => {
  javaRequirementRequest += 1;
  if (settingsDialog.open && !javaDownloadPanel.hidden && !javaDownloadActive) {
    void prepareJavaDownloadSelection();
  }
  rememberSelectedGame(versionSelect.value);
  refreshJavaReadiness();
  if (versionSelect.value) {
    gameStatus.textContent = `已选择 Minecraft ${versionSelect.value}`;
    statusBadge.textContent = activeGameProfiles.has(gameProcessKey(versionSelect.value)) ? 'RUNNING' : 'SELECTED';
    showToast(`已选择 Minecraft ${versionSelect.value}`);
  } else {
    gameStatus.textContent = '请选择游戏版本';
    statusBadge.textContent = 'READY';
  }
  updateLaunchButtonState();
  updateVersionAction();
});

document.querySelector('#manageButton').addEventListener('click', async () => {
  try {
    if (minecraft) {
      await minecraft.openDirectory(versionSelect.value || undefined);
    } else {
      showToast('Electron 中将打开 .minecraft 游戏目录');
    }
  } catch (error) {
    showProblem(error);
  }
});

updateLaunchButtonState();

// —— 首次启动 Java 环境检测 ——
async function performJavaCheck() {
  if (!settingsApi?.detectJava) return;
  if (window.localStorage.getItem(JAVA_CHECK_SKIP_KEY) === '1') return;
  try {
    const result = await refreshAutoJavaDetection();
    if (result?.available) {
      window.localStorage.setItem(JAVA_CHECK_SKIP_KEY, '1');
      return;
    }
  } catch {
    // 检测失败时继续弹出引导，不阻断使用
  }
  showToast('未检测到 Java，可启动游戏后按提示一键下载；你可以继续使用启动器');
}

const startupScreen = document.querySelector('#startupScreen');
const startupTitle = document.querySelector('#startupTitle');
const startupMessage = document.querySelector('#startupMessage');
const startupProgress = document.querySelector('#startupProgress');
const startupRetryButton = document.querySelector('#startupRetryButton');
const startupSystemDirectoryButton = document.querySelector('#startupSystemDirectoryButton');
const startupErrorDetails = document.querySelector('#startupErrorDetails');
const startupError = document.querySelector('#startupError');
const launcherStage = document.querySelector('#launcherStage');
let startupPreparing = false;
let startupDirectoryChanging = false;

function renderStartupProgress(state) {
  startupMessage.textContent = state.phase === 'ready' ? '正在打开启动器…' : state.message;
  startupProgress.value = Math.min(95, Math.max(0, Number(state.progress) * 0.95 || 0));
}

async function prepareLauncher() {
  if (startupPreparing || startupDirectoryChanging || startupScreen.dataset.state === 'ready') return;
  startupPreparing = true;
  startupScreen.dataset.state = 'preparing';
  startupScreen.setAttribute('aria-busy', 'true');
  startupTitle.textContent = '正在准备启动器';
  startupMessage.textContent = '正在检查启动所需文件…';
  startupProgress.value = 0;
  startupRetryButton.hidden = true;
  startupSystemDirectoryButton.hidden = true;
  startupErrorDetails.hidden = true;
  startupErrorDetails.open = false;
  startupError.textContent = '';
  let stopProgress;
  try {
    stopProgress = environment?.startup?.onProgress?.(renderStartupProgress);
    if (environment) {
      if (!environment.startup?.prepare) throw new Error('启动准备组件缺失，请重新安装完整的启动器。');
      const result = await environment.startup.prepare();
      if (!result?.ready) throw new Error('启动准备尚未完成，请重试。');
      for (const error of result.moduleErrors ?? []) {
        showToast(`部分功能暂不可用：${error.message}`, true);
      }
    }
    startupMessage.textContent = '正在打开启动器…';
    startupProgress.value = 100;
    startupScreen.dataset.state = 'ready';
    startupScreen.setAttribute('aria-busy', 'false');
    startupScreen.hidden = true;
    launcherStage.inert = false;
    launcherStage.removeAttribute('aria-hidden');
    document.querySelector('.launcher-app').classList.remove('is-preparing');
    environment?.diagnostics?.markStartup('core-ready');
  } catch (error) {
    startupScreen.dataset.state = 'error';
    startupScreen.setAttribute('aria-busy', 'false');
    startupTitle.textContent = '启动器准备未完成';
    const canChangeDirectory = error.phase === 'preparing-directories'
      && error.details?.gameDirectoryMode === 'local' && Boolean(settingsApi?.update);
    startupMessage.textContent = canChangeDirectory ? '游戏目录无法写入，可以改用系统游戏目录。'
      : error.code === 'STARTUP_RESOURCE_MISSING' ? '请重新下载完整启动器，替换后重新准备。'
        : error.code === 'CONFIG_CORRUPT' ? '请根据错误详情恢复配置文件后重试。'
          : '请检查文件和目录权限，处理后重新准备。';
    startupError.textContent = readableError(error);
    startupErrorDetails.hidden = false;
    startupErrorDetails.open = true;
    startupRetryButton.hidden = false;
    startupSystemDirectoryButton.hidden = !canChangeDirectory;
    environment?.diagnostics?.reportError?.(`启动准备失败：${readableError(error)}`);
    return;
  } finally {
    stopProgress?.();
    startupPreparing = false;
  }
  // Each module owns its loading and failure state. Home remains usable even
  // when settings, account storage or game-directory scanning is unavailable.
  void Promise.resolve().then(() => environment?.diagnostics?.rendererReady?.()).catch((error) => {
    environment?.diagnostics?.reportError?.(`窗口健康确认失败：${readableError(error)}`);
  });
  const settingsReady = Promise.resolve().then(() => loadLauncherSettings({ strict: true, detectJava: false })).then(() => {
    environment?.diagnostics?.markStartup('settings-loaded');
  });
  void settingsReady.catch((error) => {
    showToast(`启动设置读取失败，可在设置中重试：${readableError(error)}`, true);
    environment?.diagnostics?.reportError?.(`设置模块读取失败：${readableError(error)}`);
  });
  void Promise.resolve().then(() => loadAccountState({ strict: true })).then(() => {
    environment?.diagnostics?.markStartup('accounts-loaded');
  }).catch((error) => {
    accountName.textContent = '账户读取失败，点击管理重试';
    showToast(`账户读取失败，点击管理可重试：${readableError(error)}`, true);
  });
  void Promise.resolve().then(() => loadLocalProfiles(true)).then(() => {
    environment?.diagnostics?.markStartup('profiles-loaded');
  }).catch((error) => {
    showToast(`游戏列表读取失败，可在「切换版本」中重试：${readableError(error)}`, true);
  });
  if (updaterApi?.getState) {
    void Promise.resolve().then(() => updaterApi.getState()).then(renderLauncherUpdate).catch((error) => {
      renderLauncherUpdate({ status: 'error', message: readableError(error), progress: 0 });
    });
  }
  void withModpackUi((ui) => ui.restore());
  // Java uses the saved path and runtimes; only its own initial check waits
  // for settings, while the other modules have already started.
  void settingsReady.then(async () => {
    try {
      await refreshAutoJavaDetection();
      environment?.diagnostics?.markStartup('java-detected');
      await performJavaCheck();
    } catch (error) {
      showToast(`Java 检测失败：${readableError(error)}`, true);
    }
  }, () => {});
}

startupRetryButton.addEventListener('click', () => { void prepareLauncher(); });
startupSystemDirectoryButton.addEventListener('click', async () => {
  if (startupPreparing || startupDirectoryChanging) return;
  startupDirectoryChanging = true;
  startupRetryButton.disabled = true;
  startupSystemDirectoryButton.disabled = true;
  try {
    await settingsApi.update({ gameDirectoryMode: 'system' });
  } catch (error) {
    startupError.textContent = readableError(error);
    return;
  } finally {
    startupDirectoryChanging = false;
    startupRetryButton.disabled = false;
    startupSystemDirectoryButton.disabled = false;
  }
  await prepareLauncher();
});

// Paint the preparation page before touching configuration and game directories.
requestAnimationFrame(() => requestAnimationFrame(async () => {
  environment?.diagnostics?.markStartup('renderer-painted');
  await environment?.diagnostics?.whenWindowShown?.();
  await prepareLauncher();
}));
