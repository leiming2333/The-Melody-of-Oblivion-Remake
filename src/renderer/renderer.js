const environment = window.launcherEnvironment;
const windowControls = environment?.windowControls;
const minecraft = environment?.minecraft;
const accountsApi = environment?.accounts;
const settingsApi = environment?.settings;
const filesApi = environment?.files;

const launchButton = document.querySelector('#launchButton');
const launchLabel = document.querySelector('#launchLabel');
const launchHint = document.querySelector('#launchHint');
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
const littleSkinProfileSelect = document.querySelector('#littleSkinProfileSelect');
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
const refreshVersionsButton = document.querySelector('#refreshVersionsButton');
const deleteVersionButton = document.querySelector('#deleteVersionButton');
const clearVersionSelectionButton = document.querySelector('#clearVersionSelectionButton');
const downloadVersionButton = document.querySelector('#downloadVersionButton');
const cancelDownloadButton = document.querySelector('#cancelDownloadButton');
const downloadStatus = document.querySelector('#downloadStatus');
const downloadMessage = document.querySelector('#downloadMessage');
const downloadPercent = document.querySelector('#downloadPercent');
const downloadProgress = document.querySelector('#downloadProgress');
const downloadSpeed = document.querySelector('#downloadSpeed');
const downloadEta = document.querySelector('#downloadEta');
const settingsDialog = document.querySelector('#settingsDialog');
const javaSelect = document.querySelector('#javaSelect');
const javaBrowseButton = document.querySelector('#javaBrowseButton');
const javaPathHint = document.querySelector('#javaPathHint');
const memoryRange = document.querySelector('#memoryRange');
const memoryValue = document.querySelector('#memoryValue');
const downloadConcurrencySelect = document.querySelector('#downloadConcurrencySelect');
const downloadSourceSelect = document.querySelector('#downloadSourceSelect');
const autoUpdateCheck = document.querySelector('#autoUpdateCheck');
const sourceHint = document.querySelector('#sourceHint');
const toast = document.querySelector('#toast');
const modpackDropOverlay = document.querySelector('#modpackDropOverlay');
const backgroundDownloadBar = document.querySelector('#backgroundDownloadBar');
const bgDownloadLabel = document.querySelector('#bgDownloadLabel');
const bgDownloadProgress = document.querySelector('#bgDownloadProgress');
const bgDownloadPercent = document.querySelector('#bgDownloadPercent');
const bgDownloadSpeed = document.querySelector('#bgDownloadSpeed');
const wallpaperSlides = [...document.querySelectorAll('.background-slide')];
const wallpaperDots = [...document.querySelectorAll('.wallpaper-dot')];

let toastTimer;
let wallpaperIndex = 0;
let wallpaperTimer;
let localProfiles = [];
let localProfilesLoaded = false;
let localProfilesLoadingPromise;
let remoteVersions = [];
let filteredVersions = [];
let versionCatalogLoaded = false;
let versionCatalogLoading = false;
let versionDownloadActive = false;
let versionDeleteActive = false;
let versionVerifyActive = false;
let modpackInstallActive = false;
let launchRequestActive = false;
let downloadCancelRequested = false;
let activeDownloadLabel = '';
let lastDownloadProgress = null;
let backgroundDownloadHideTimer;
let loaderVersions = [];
let loaderCatalogLoading = false;
let loaderLoadToken = 0;
const activeGameProfiles = new Set();
let accountState = { currentId: null, current: null, accounts: [] };
let launcherSettings = {
  javaPath: '',
  downloadSource: 'auto',
  downloadConcurrency: 16,
  memoryMb: 4096,
  autoUpdate: true
};
let launcherSettingsLoaded = false;
let selectedJavaPath = '';
let selectedJavaMajorVersion;
let microsoftLoginSessionId;
let microsoftLoginActive = false;
let littleSkinLoginSessionId;
let littleSkinLoginActive = false;

const loaderNames = Object.freeze({
  vanilla: '原版',
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  custom: '自定义'
});

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
  return normalizedOnlineSkinUrl(account?.skinUrl);
}

function applySkinAvatar(element, skinUrl) {
  element.style.backgroundImage = skinUrl ? `url("${skinUrl}"), url("${skinUrl}")` : '';
  element.classList.toggle('has-player-skin', Boolean(skinUrl));
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

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function readableError(error) {
  const message = error?.message ?? String(error);
  return message.replace(/^Error invoking remote method '[^']+': Error: /, '');
}

function setAccountHint(message, isError = false) {
  accountFormHint.textContent = message;
  accountFormHint.classList.toggle('is-error', isError);
}

function updateAccountCard() {
  playerAvatar.classList.remove('is-alex', 'has-player-skin');
  playerAvatar.style.backgroundImage = '';
  if (accountState.current) {
    accountName.textContent = accountState.current.name;
    accountType.textContent = accountState.current.type === 'microsoft'
      ? 'Microsoft 正版'
      : accountState.current.type === 'yggdrasil'
        ? 'LittleSkin 外置登录'
        : '离线账户';
    applySkinAvatar(playerAvatar, skinUrlForAccount(accountState.current));
  } else {
    accountName.textContent = '未添加账户';
    accountType.textContent = '游戏账户';
  }
}

async function refreshCurrentOnlineSkin() {
  if (!['microsoft', 'yggdrasil'].includes(accountState.current?.type)
    || !accountsApi?.refreshSkin) return;
  try {
    accountState = await accountsApi.refreshSkin(accountState.current.id);
    updateAccountCard();
    renderAccountList();
  } catch (error) {
    showToast(readableError(error));
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
    showToast(readableError(error));
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
    showToast(readableError(error));
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
    showToast(readableError(error));
  }
}

function renderAccountList() {
  accountList.replaceChildren();
  accountEmpty.hidden = accountState.accounts.length > 0;

  for (const account of accountState.accounts) {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.classList.toggle('is-current', account.id === accountState.currentId);

    const avatar = document.createElement('span');
    avatar.className = 'account-row-avatar';
    const skinUrl = skinUrlForAccount(account);
    applySkinAvatar(avatar, skinUrl);
    avatar.textContent = skinUrl ? '' : account.name.slice(0, 1).toUpperCase();

    const copy = document.createElement('span');
    copy.className = 'account-row-copy';
    const name = document.createElement('strong');
    name.textContent = account.name;
    const detail = document.createElement('small');
    detail.textContent = account.type === 'offline'
      ? `离线账户 · ${account.uuid}`
      : account.type === 'yggdrasil'
        ? `LittleSkin 外置 · ${account.uuid}`
        : `Microsoft 正版 · ${account.uuid}`;
    copy.append(name, detail);

    const selectButton = document.createElement('button');
    selectButton.type = 'button';
    selectButton.textContent = account.id === accountState.currentId ? '当前' : '使用';
    selectButton.disabled = account.id === accountState.currentId;
    selectButton.addEventListener('click', () => selectAccount(account.id));

    let skinButton;
    if (account.type === 'offline') {
      skinButton = document.createElement('button');
      skinButton.type = 'button';
      skinButton.className = 'skin-model-button';
      const nextSkinModel = account.skinModel === 'alex' ? 'steve' : 'alex';
      skinButton.textContent = '切换';
      skinButton.title = `切换为${skinModelNames[nextSkinModel]}`;
      skinButton.addEventListener('click', () => setAccountSkinModel(account.id, nextSkinModel));
    }

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'remove-account-button';
    removeButton.textContent = '删除';
    removeButton.addEventListener('click', () => removeAccount(account.id));

    row.append(avatar, copy);
    if (skinButton) row.append(skinButton);
    row.append(selectButton, removeButton);
    accountList.append(row);
  }
}

async function loadAccountState() {
  try {
    if (accountsApi) {
      accountState = await accountsApi.getState();
    }
    updateAccountCard();
    renderAccountList();
    void refreshCurrentOnlineSkin();
  } catch (error) {
    showToast(`账户读取失败：${readableError(error)}`);
  }
}

function applySettingsToForm() {
  selectedJavaPath = launcherSettings.javaPath ?? '';
  selectedJavaMajorVersion = undefined;
  renderJavaPathSetting();
  downloadSourceSelect.value = launcherSettings.downloadSource;
  downloadConcurrencySelect.value = String(launcherSettings.downloadConcurrency);
  memoryRange.value = String(launcherSettings.memoryMb);
  memoryValue.value = `${launcherSettings.memoryMb} MB`;
  autoUpdateCheck.checked = launcherSettings.autoUpdate;
  sourceHint.textContent = `${launcherSettings.downloadConcurrency} 路并发下载`;
}

function renderJavaPathSetting() {
  const hasCustomPath = Boolean(selectedJavaPath);
  javaSelect.value = hasCustomPath ? 'custom' : 'auto';
  javaBrowseButton.textContent = hasCustomPath ? '更换' : '选择';
  javaPathHint.classList.toggle('is-custom', hasCustomPath);
  if (hasCustomPath) {
    const versionLabel = Number.isInteger(selectedJavaMajorVersion)
      ? `Java ${selectedJavaMajorVersion} · `
      : '';
    javaPathHint.textContent = `${versionLabel}${selectedJavaPath}`;
    javaPathHint.title = selectedJavaPath;
  } else {
    javaPathHint.textContent = '启动时会从 JAVA_HOME 与系统 PATH 中自动查找 Java。';
    javaPathHint.removeAttribute('title');
  }
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
    renderJavaPathSetting();
    showToast(`已选择 Java ${selection.majorVersion}`);
    return true;
  } catch (error) {
    showToast(readableError(error));
    return false;
  } finally {
    javaBrowseButton.disabled = false;
  }
}

async function loadLauncherSettings() {
  try {
    if (settingsApi) launcherSettings = await settingsApi.getState();
    launcherSettingsLoaded = true;
    applySettingsToForm();
  } catch (error) {
    showToast(`设置读取失败：${readableError(error)}`);
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

  setMicrosoftLoginBusy(true);
  microsoftDevicePanel.hidden = false;
  microsoftDeviceCode.textContent = '正在连接…';
  microsoftLoginHint.textContent = '正在向 Microsoft 申请登录代码';
  try {
    const session = await accountsApi.beginMicrosoft();
    microsoftLoginSessionId = session.sessionId;
    microsoftDeviceCode.textContent = session.userCode;
    const copied = await copyMicrosoftDeviceCode(session.userCode, false);
    microsoftLoginHint.textContent = copied
      ? '代码已复制；授权页面完成后会自动登录'
      : '授权页面已打开，完成后会自动登录';
    const completedState = await accountsApi.completeMicrosoft(session.sessionId);
    if (microsoftLoginSessionId !== session.sessionId) return;
    accountState = completedState;
    updateAccountCard();
    renderAccountList();
    microsoftDevicePanel.hidden = true;
    showToast(`Microsoft 登录成功：${accountState.current?.name ?? 'Minecraft 玩家'}`);
  } catch (error) {
    const message = readableError(error);
    if (!message.includes('登录已取消')) {
      microsoftLoginHint.textContent = message;
      showToast(message);
    }
  } finally {
    microsoftLoginSessionId = undefined;
    setMicrosoftLoginBusy(false);
  }
}

async function cancelMicrosoftLogin() {
  const sessionId = microsoftLoginSessionId;
  microsoftLoginSessionId = undefined;
  if (sessionId) await accountsApi?.cancelMicrosoft?.(sessionId);
  microsoftDevicePanel.hidden = true;
  setMicrosoftLoginBusy(false);
  showToast('Microsoft 登录已取消');
}

function setLittleSkinLoginBusy(active) {
  littleSkinLoginActive = active;
  littleSkinLoginButton.disabled = active;
  littleSkinUsernameInput.disabled = active || Boolean(littleSkinLoginSessionId);
  littleSkinPasswordInput.disabled = active || Boolean(littleSkinLoginSessionId);
  littleSkinLoginButton.textContent = active
    ? '正在登录…'
    : littleSkinLoginSessionId
      ? '使用所选角色'
      : '登录并同步';
}

function resetLittleSkinProfileSelection() {
  littleSkinLoginSessionId = undefined;
  littleSkinProfileSelect.replaceChildren();
  littleSkinProfileSelect.hidden = true;
  setLittleSkinLoginBusy(false);
}

async function beginLittleSkinLogin() {
  if (littleSkinLoginActive) return;
  if (!accountsApi?.loginLittleSkin || !accountsApi?.selectLittleSkinProfile) {
    showToast('请在 Electron 启动器中使用 LittleSkin 登录');
    return;
  }

  const selectingProfile = Boolean(littleSkinLoginSessionId);
  const username = littleSkinUsernameInput.value.trim();
  const password = littleSkinPasswordInput.value;
  if (!selectingProfile && (!username || !password)) {
    littleSkinLoginHint.textContent = '请输入 LittleSkin 邮箱（或角色名）和密码。';
    littleSkinLoginHint.classList.add('is-error');
    return;
  }

  setLittleSkinLoginBusy(true);
  littleSkinLoginHint.classList.remove('is-error');
  littleSkinLoginHint.textContent = selectingProfile
    ? '正在切换到所选角色…'
    : '正在验证账户并同步角色材质…';
  try {
    let nextState;
    if (selectingProfile) {
      nextState = await accountsApi.selectLittleSkinProfile(
        littleSkinLoginSessionId,
        littleSkinProfileSelect.value
      );
    } else {
      const result = await accountsApi.loginLittleSkin(username, password);
      littleSkinPasswordInput.value = '';
      if (result.needsProfileSelection) {
        littleSkinLoginSessionId = result.sessionId;
        for (const profile of result.profiles) {
          const option = document.createElement('option');
          option.value = profile.id;
          option.textContent = profile.name;
          littleSkinProfileSelect.append(option);
        }
        littleSkinProfileSelect.hidden = false;
        littleSkinLoginHint.textContent = '此账户有多个角色，请选择本次使用的角色。';
        return;
      }
      nextState = result.state;
    }

    accountState = nextState;
    updateAccountCard();
    renderAccountList();
    littleSkinLoginHint.textContent = `已同步角色：${accountState.current?.name ?? 'LittleSkin 玩家'}`;
    showToast(`LittleSkin 登录成功：${accountState.current?.name ?? 'Minecraft 玩家'}`);
    resetLittleSkinProfileSelection();
  } catch (error) {
    const message = readableError(error);
    littleSkinLoginHint.textContent = message;
    littleSkinLoginHint.classList.add('is-error');
    if (/过期|重新登录/.test(message)) resetLittleSkinProfileSelection();
    showToast(message);
  } finally {
    setLittleSkinLoginBusy(false);
  }
}

function selectWallpaper(index) {
  wallpaperIndex = index;

  wallpaperSlides.forEach((slide, slideIndex) => {
    slide.classList.toggle('is-active', slideIndex === index);
  });

  wallpaperDots.forEach((dot, dotIndex) => {
    const isActive = dotIndex === index;
    dot.classList.toggle('is-active', isActive);
    dot.setAttribute('aria-pressed', String(isActive));
  });
}

function startWallpaperRotation() {
  window.clearInterval(wallpaperTimer);

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }

  wallpaperTimer = window.setInterval(() => {
    selectWallpaper((wallpaperIndex + 1) % wallpaperSlides.length);
  }, 9000);
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

function formatSpeed(bytesPerSecond) {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function scheduleHideBackgroundDownloadBar() {
  window.clearTimeout(backgroundDownloadHideTimer);
  backgroundDownloadHideTimer = window.setTimeout(() => {
    backgroundDownloadBar.hidden = true;
  }, 4000);
}

function updateBackgroundDownloadBar(progress) {
  if (!progress) return;
  backgroundDownloadBar.hidden = false;
  backgroundDownloadBar.classList.remove('is-complete', 'is-error');

  const totalFiles = progress.totalFiles ?? 0;
  const completedFiles = progress.completedFiles ?? 0;
  const totalBytes = progress.totalBytes ?? 0;
  const completedBytes = progress.completedBytes ?? 0;
  const useByteProgress = totalBytes > 0;
  const progressTotal = useByteProgress ? totalBytes : totalFiles;
  const progressValue = useByteProgress ? completedBytes : completedFiles;
  const percent = progressTotal > 0
    ? Math.min(100, Math.round((progressValue / progressTotal) * 100))
    : 0;

  bgDownloadProgress.max = Math.max(progressTotal, 1);
  bgDownloadProgress.value = Math.min(progressValue, bgDownloadProgress.max);
  bgDownloadPercent.textContent = progress.phase === 'complete' ? '100%' : `${percent}%`;

  if (progress.phase === 'complete') {
    bgDownloadLabel.textContent = `${activeDownloadLabel} 已完成`;
    backgroundDownloadBar.classList.add('is-complete');
    bgDownloadSpeed.textContent = '已完成';
    scheduleHideBackgroundDownloadBar();
  } else if (downloadCancelRequested) {
    bgDownloadLabel.textContent = `正在取消 ${activeDownloadLabel}…`;
    bgDownloadSpeed.textContent = '取消中';
  } else if (progress.phase === 'preparing') {
    bgDownloadLabel.textContent = progress.message ?? `正在准备 ${activeDownloadLabel}…`;
    bgDownloadSpeed.textContent = '准备中';
  } else {
    bgDownloadLabel.textContent = progress.message ?? `正在下载 ${activeDownloadLabel}…`;
    const bytesPerSecond = Number(progress.bytesPerSecond);
    bgDownloadSpeed.textContent = Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
      ? formatSpeed(bytesPerSecond)
      : '—';
  }
}

function updateDownloadProgress(progress) {
  lastDownloadProgress = progress;
  updateBackgroundDownloadBar(progress);
  if (downloadCancelRequested && progress.phase !== 'complete') return;
  downloadStatus.hidden = false;
  downloadMessage.textContent = progress.message ?? '正在准备下载…';

  const totalFiles = progress.totalFiles ?? 0;
  const completedFiles = progress.completedFiles ?? 0;
  const totalBytes = progress.totalBytes ?? 0;
  const completedBytes = progress.completedBytes ?? 0;
  const useByteProgress = totalBytes > 0;
  const progressTotal = useByteProgress ? totalBytes : totalFiles;
  const progressValue = useByteProgress ? completedBytes : completedFiles;
  const percent = progressTotal > 0
    ? Math.min(100, Math.round((progressValue / progressTotal) * 100))
    : 0;
  downloadProgress.max = Math.max(progressTotal, 1);
  downloadProgress.value = Math.min(progressValue, downloadProgress.max);
  downloadPercent.textContent = progress.phase === 'complete' ? '100%' : `${percent}%`;

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

function selectedRemoteVersion() {
  if (!versionCatalog.selectedOptions[0] || versionCatalog.selectedOptions[0].disabled) {
    return undefined;
  }
  return remoteVersions.find((version) => version.id === versionCatalog.value);
}

function renderLocalProfileOptions() {
  const previousProfileId = versionSelect.value;
  const installedProfiles = localProfiles.filter((profile) => profile.valid && profile.complete);
  versionSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = installedProfiles.length > 0 ? '请选择已安装游戏' : '未发现已安装游戏';
  placeholder.disabled = installedProfiles.length > 0;
  placeholder.hidden = installedProfiles.length > 0;
  versionSelect.append(placeholder);

  for (const profile of installedProfiles) {
    const option = document.createElement('option');
    option.value = profile.targetId ?? profile.profileId;
    const loaderLabel = loaderNames[profile.loaderType] ?? '自定义';
    const displayName = profile.displayName ?? profile.profileId;
    option.textContent = profile.loaderType === 'vanilla'
      ? displayName
      : `${displayName} · ${loaderLabel}`;
    versionSelect.append(option);
  }

  const preferredProfileId = previousProfileId || rememberedSelectedGame();
  const preferredOption = [...versionSelect.options]
    .find((option) => option.value === preferredProfileId && !option.disabled);
  const selectedOption = preferredOption
    ?? [...versionSelect.options].find((option) => option.value && !option.disabled);
  versionSelect.value = selectedOption?.value ?? '';
  rememberSelectedGame(versionSelect.value);
  if (selectedOption) {
    const selectedProfile = installedProfiles.find((profile) => (
      (profile.targetId ?? profile.profileId) === selectedOption.value
    ));
    gameStatus.textContent = `已选择 ${selectedProfile?.displayName ?? selectedProfile?.profileId ?? selectedOption.value}`;
    statusBadge.textContent = activeGameProfiles.has(selectedOption.value) ? 'RUNNING' : 'SELECTED';
  } else if (previousProfileId) {
    gameStatus.textContent = '请选择游戏版本';
    statusBadge.textContent = 'READY';
  }
  updateLaunchButtonState();
  updateVersionAction();
}

async function loadLocalProfiles(force = false) {
  if (localProfilesLoadingPromise) return localProfilesLoadingPromise;
  if (localProfilesLoaded && !force) return localProfiles;

  localProfilesLoadingPromise = (async () => {
    const result = minecraft?.listLocalVersions
      ? await minecraft.listLocalVersions()
      : await delay(80).then(fallbackLocalVersionResult);
    localProfiles = result.profiles ?? [];
    localProfilesLoaded = true;
    renderLocalProfileOptions();
    return localProfiles;
  })();
  try {
    return await localProfilesLoadingPromise;
  } finally {
    localProfilesLoadingPromise = undefined;
  }
}

function localBaseProfiles() {
  return localProfiles.filter((profile) => profile.valid && !profile.inheritsFrom && !profile.isInstance);
}

function seedCatalogWithLocalProfiles() {
  remoteVersions = localBaseProfiles().map((profile) => ({
    id: profile.profileId,
    type: profile.type,
    releaseTime: profile.releaseTime,
    installed: profile.complete,
    complete: profile.complete,
    localFilesPresent: true,
    localOnly: true,
    profileId: profile.profileId
  }));
}

function mergeRemoteAndLocalVersions(onlineVersions) {
  const localById = new Map(localBaseProfiles().map((profile) => [profile.profileId, profile]));
  const onlineIds = new Set(onlineVersions.map((version) => version.id));
  const merged = onlineVersions.map((version) => {
    const local = localById.get(version.id);
    return local ? {
      ...version,
      installed: version.installed || local.complete,
      complete: local.complete,
      localFilesPresent: true,
      profileId: local.profileId
    } : version;
  });
  for (const local of localBaseProfiles()) {
    if (onlineIds.has(local.profileId)) continue;
    merged.push({
      id: local.profileId,
      type: local.type,
      releaseTime: local.releaseTime,
      installed: local.complete,
      complete: local.complete,
      localFilesPresent: true,
      localOnly: true,
      profileId: local.profileId
    });
  }
  return merged;
}

function selectedLoaderVersion() {
  return loaderVersions.find((loader) => loader.version === loaderVersionSelect.value);
}

function renderLoaderCatalog(preferredVersion) {
  const previousVersion = preferredVersion ?? loaderVersionSelect.value;
  loaderVersionSelect.replaceChildren();

  const groups = [
    { label: '已安装', loaders: loaderVersions.filter((loader) => loader.installed) },
    { label: '可安装', loaders: loaderVersions.filter((loader) => !loader.installed) }
  ];
  for (const group of groups) {
    if (group.loaders.length === 0) continue;
    const optionGroup = document.createElement('optgroup');
    optionGroup.label = `${group.label}（${group.loaders.length}）`;
    for (const loader of group.loaders) {
      const option = document.createElement('option');
      option.value = loader.version;
      const stability = loader.stable ? '' : ' · 测试版';
      option.textContent = `${loader.version}${stability}`;
      optionGroup.append(option);
    }
    loaderVersionSelect.append(optionGroup);
  }

  const previousOption = [...loaderVersionSelect.options]
    .find((option) => option.value === previousVersion);
  if (previousOption) {
    previousOption.selected = true;
  } else if (loaderVersionSelect.options.length > 0) {
    loaderVersionSelect.selectedIndex = 0;
  } else {
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = '该版本暂无可用加载器';
    loaderVersionSelect.append(emptyOption);
  }

  loaderVersionSelect.disabled = loaderTypeSelect.value === 'vanilla' || loaderCatalogLoading;
  updateVersionAction();
}

async function loadLoaderCatalog(force = false) {
  const gameVersion = selectedRemoteVersion();
  const loaderType = loaderTypeSelect.value;
  const requestToken = ++loaderLoadToken;
  loaderVersions = [];

  if (!gameVersion) {
    renderLoaderCatalog();
    return;
  }

  if (loaderType === 'vanilla') {
    loaderVersions = [{
      version: gameVersion.id,
      stable: true,
      installed: gameVersion.installed,
      profileId: gameVersion.installed ? gameVersion.id : undefined
    }];
    renderLoaderCatalog(gameVersion.id);
    return;
  }

  loaderCatalogLoading = true;
  loaderVersionSelect.disabled = true;
  loaderVersionSelect.replaceChildren();
  const loadingOption = document.createElement('option');
  loadingOption.textContent = `正在获取 ${loaderNames[loaderType]} 版本…`;
  loaderVersionSelect.append(loadingOption);
  updateVersionAction();

  try {
    const result = minecraft?.listLoaders
      ? await minecraft.listLoaders(gameVersion.id, loaderType, { force })
      : await delay(180).then(() => fallbackLoaderResult(gameVersion.id, loaderType));
    if (requestToken !== loaderLoadToken) return;
    loaderVersions = result.versions;
    renderLoaderCatalog();
    if (loaderVersions.length === 0) {
      versionEmpty.textContent = `${loaderNames[loaderType]} 暂不支持 Minecraft ${gameVersion.id}`;
    }
  } catch (error) {
    if (requestToken !== loaderLoadToken) return;
    const message = readableError(error);
    loaderVersions = [];
    renderLoaderCatalog();
    versionEmpty.textContent = `${loaderNames[loaderType]} 获取失败：${message}`;
    showToast(message);
  } finally {
    if (requestToken === loaderLoadToken) {
      loaderCatalogLoading = false;
      loaderVersionSelect.disabled = loaderType === 'vanilla';
      updateVersionAction();
    }
  }
}

function updateVersionAction() {
  const version = selectedRemoteVersion();
  const loaderType = loaderTypeSelect.value;
  const loader = selectedLoaderVersion();
  const busy = versionDownloadActive || versionDeleteActive || versionVerifyActive;
  downloadVersionButton.disabled = !version || !loader || busy || loaderCatalogLoading;
  deleteVersionButton.disabled = !loader?.installed || busy;
  clearVersionSelectionButton.disabled = !versionSelect.value || busy || launchRequestActive;
  if (!version) {
    downloadVersionButton.textContent = '选择版本';
    return;
  }
  if (!loader) {
    downloadVersionButton.textContent = loaderCatalogLoading ? '正在获取加载器' : '暂无可用版本';
    return;
  }
  if (loader.installed) {
    downloadVersionButton.textContent = '使用此版本';
    return;
  }
  downloadVersionButton.textContent = loaderType === 'vanilla'
    ? '下载原版'
    : `安装 ${loaderNames[loaderType]}`;
}

async function verifyLocalVersionsAfterLoad() {
  const localVersions = remoteVersions.filter((version) => (
    version.localFilesPresent || version.installed
  ));
  if (localVersions.length === 0) return;

  const preferredId = versionCatalog.value || versionSelect.value;
  let completeCount = 0;
  let incompleteCount = 0;
  let failedCount = 0;
  versionVerifyActive = true;
  versionCatalog.disabled = true;
  versionSearch.disabled = true;
  versionTypeFilter.disabled = true;
  refreshVersionsButton.disabled = true;
  updateVersionAction();

  for (let index = 0; index < localVersions.length; index += 1) {
    const version = localVersions[index];
    versionEmpty.textContent = `正在自动检测 Minecraft ${version.id}（${index + 1}/${localVersions.length}）…`;
    try {
      const result = minecraft?.verifyVersion
        ? await minecraft.verifyVersion(version.id)
        : { complete: version.installed };
      version.installed = result.complete;
      if (result.complete) completeCount += 1;
      else incompleteCount += 1;
    } catch {
      failedCount += 1;
    }
  }

  versionVerifyActive = false;
  renderVersionCatalog(preferredId);
  const details = [`${completeCount} 个完整`];
  if (incompleteCount > 0) details.push(`${incompleteCount} 个待补齐`);
  if (failedCount > 0) details.push(`${failedCount} 个检测失败`);
  versionEmpty.textContent = `文件自动检测完成：${details.join('，')}`;
  updateVersionAction();
}

function renderVersionCatalog(preferredId) {
  const query = versionSearch.value.trim().toLowerCase();
  const type = versionTypeFilter.value;
  const previousId = preferredId ?? versionCatalog.value;

  filteredVersions = remoteVersions.filter((version) => {
    const typeMatches = type === 'all' || version.type === type;
    const queryMatches = !query || version.id.toLowerCase().includes(query);
    return typeMatches && queryMatches;
  });

  const installedVersions = filteredVersions.filter((version) => version.installed);
  const availableVersions = filteredVersions.filter((version) => !version.installed);

  versionCatalog.replaceChildren();

  if (installedVersions.length > 0) {
    const installedGroup = document.createElement('optgroup');
    installedGroup.label = `已安装（${installedVersions.length}）`;
    for (const version of installedVersions) {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = version.id;
      installedGroup.append(option);
    }
    versionCatalog.append(installedGroup);
  }

  if (availableVersions.length > 0) {
    const availableGroup = document.createElement('optgroup');
    availableGroup.label = `可下载（${availableVersions.length}）`;
    for (const version of availableVersions) {
      const option = document.createElement('option');
      option.value = version.id;
      option.textContent = version.id;
      option.disabled = version.localOnly === true;
      availableGroup.append(option);
    }
    versionCatalog.append(availableGroup);
  }

  const preferredOption = [...versionCatalog.options]
    .find((option) => option.value === previousId && !option.disabled);
  if (preferredOption) {
    preferredOption.selected = true;
  } else {
    const firstEnabledOption = [...versionCatalog.options].find((option) => !option.disabled);
    versionCatalog.selectedIndex = firstEnabledOption ? firstEnabledOption.index : -1;
  }

  versionEmpty.textContent = filteredVersions.length
    ? `共 ${filteredVersions.length} 个版本，发现 ${localProfiles.length} 个启动配置`
    : '没有符合条件的版本';
  updateVersionAction();
}

async function loadVersionCatalog(force = false) {
  if (versionCatalogLoading) {
    return;
  }

  versionCatalogLoading = true;
  versionCatalog.disabled = true;
  versionSearch.disabled = true;
  versionTypeFilter.disabled = true;
  refreshVersionsButton.disabled = true;
  downloadVersionButton.disabled = true;
  versionEmpty.textContent = '正在检查已安装版本…';

  try {
    await loadLocalProfiles(force);
    seedCatalogWithLocalProfiles();
    renderVersionCatalog(versionSelect.value);
    versionEmpty.textContent = `已检查 ${localProfiles.length} 个启动配置，正在加载全部版本…`;
    const result = minecraft
      ? await minecraft.listVersions({ force })
      : await delay(250).then(fallbackVersionResult);
    remoteVersions = mergeRemoteAndLocalVersions(result.versions);
    versionCatalogLoaded = true;
    renderVersionCatalog(versionSelect.value);
    await loadLoaderCatalog(force);
  } catch (error) {
    const message = readableError(error);
    versionEmpty.textContent = localProfiles.length > 0
      ? `已加载 ${localProfiles.length} 个启动配置；在线版本加载失败：${message}`
      : `版本加载失败：${message}`;
    showToast(message);
  } finally {
    versionCatalogLoading = false;
    versionCatalog.disabled = false;
    versionSearch.disabled = false;
    versionTypeFilter.disabled = false;
    refreshVersionsButton.disabled = false;
    updateVersionAction();
  }
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
  showToast('已取消当前游戏版本选择');
}

async function installSelectedVersion() {
  const version = selectedRemoteVersion();
  const loaderType = loaderTypeSelect.value;
  const loader = selectedLoaderVersion();
  if (!version || !loader || versionDownloadActive) {
    return;
  }

  const loaderLabel = loaderType === 'vanilla'
    ? `Minecraft ${version.id}`
    : `Minecraft ${version.id} · ${loaderNames[loaderType]} ${loader.version}`;

  if (loader.installed) {
    useVersion(loader.profileId ?? version.id, loaderLabel);
    versionDialog.close();
    return;
  }

  versionDownloadActive = true;
  downloadCancelRequested = false;
  activeDownloadLabel = loaderLabel;
  window.clearTimeout(backgroundDownloadHideTimer);
  versionCatalog.disabled = true;
  versionSearch.disabled = true;
  versionTypeFilter.disabled = true;
  refreshVersionsButton.disabled = true;
  deleteVersionButton.disabled = true;
  downloadVersionButton.disabled = true;
  cancelDownloadButton.hidden = false;
  cancelDownloadButton.disabled = false;
  downloadStatus.hidden = false;
  updateDownloadProgress({ phase: 'preparing', message: `正在准备 ${loaderLabel}…` });
  gameStatus.textContent = `正在安装 ${loaderLabel}`;
  statusBadge.textContent = 'DOWNLOAD';

  try {
    let result;
    if (minecraft?.installLoader) {
      result = await minecraft.installLoader({
        gameVersion: version.id,
        loaderType,
        loaderVersion: loader.version
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

    version.installed = true;
    loader.installed = true;
    loader.profileId = result.profileId;
    renderVersionCatalog(version.id);
    renderLoaderCatalog(loader.version);
    useVersion(result.profileId ?? version.id, loaderLabel);
    downloadMessage.textContent = `${loaderLabel} 安装完成`;
    downloadPercent.textContent = '100%';
    statusBadge.textContent = 'READY';
  } catch (error) {
    const message = readableError(error);
    const cancelled = downloadCancelRequested || message.includes('下载已取消');
    downloadMessage.textContent = cancelled ? '下载已取消' : `下载失败：${message}`;
    downloadPercent.textContent = cancelled ? '—' : downloadPercent.textContent;
    statusBadge.textContent = cancelled ? 'READY' : 'ERROR';
    gameStatus.textContent = cancelled ? '下载已取消' : '下载失败';
    backgroundDownloadBar.classList.remove('is-complete');
    if (cancelled) {
      backgroundDownloadBar.classList.remove('is-error');
      bgDownloadLabel.textContent = `${activeDownloadLabel} 已取消`;
      bgDownloadPercent.textContent = '—';
      bgDownloadSpeed.textContent = '已取消';
    } else {
      backgroundDownloadBar.classList.add('is-error');
      bgDownloadLabel.textContent = `${activeDownloadLabel} 下载失败`;
      bgDownloadSpeed.textContent = '失败';
    }
    scheduleHideBackgroundDownloadBar();
    showToast(cancelled ? '已取消下载，并清理临时文件' : message);
  } finally {
    versionDownloadActive = false;
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

wallpaperDots.forEach((dot) => {
  dot.addEventListener('click', () => {
    selectWallpaper(Number(dot.dataset.wallpaperIndex));
    startWallpaperRotation();
  });
});

startWallpaperRotation();

document.querySelector('#minimizeButton').addEventListener('click', () => {
  windowControls?.minimize();
});

document.querySelector('#closeButton').addEventListener('click', () => {
  windowControls?.close();
});

accountButton.addEventListener('click', () => {
  renderAccountList();
  accountDialog.showModal();
  microsoftLoginButton.focus();
});

addOfflineButton.addEventListener('click', addOfflineAccount);
offlineNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addOfflineAccount();
  }
});

microsoftLoginButton.addEventListener('click', beginMicrosoftLogin);
microsoftCopyCodeButton.addEventListener('click', () => copyMicrosoftDeviceCode());
microsoftCancelLoginButton.addEventListener('click', cancelMicrosoftLogin);
littleSkinLoginButton.addEventListener('click', beginLittleSkinLogin);
littleSkinPasswordInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    beginLittleSkinLogin();
  }
});
littleSkinProfileSelect.addEventListener('change', () => {
  littleSkinLoginHint.classList.remove('is-error');
  littleSkinLoginHint.textContent = '点击“使用所选角色”完成登录。';
});

accountsApi?.onMicrosoftProgress?.((progress) => {
  if (!microsoftLoginActive || progress?.sessionId !== microsoftLoginSessionId) return;
  if (progress.message) microsoftLoginHint.textContent = progress.message;
});

document.querySelector('#settingsButton').addEventListener('click', async () => {
  if (!launcherSettingsLoaded) await loadLauncherSettings();
  applySettingsToForm();
  settingsDialog.showModal();
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

backgroundDownloadBar.addEventListener('click', () => {
  if (versionDialog.open) return;
  versionDialog.showModal();
  if (versionDownloadActive && lastDownloadProgress) {
    updateDownloadProgress(lastDownloadProgress);
  }
});

settingsDialog.addEventListener('close', async () => {
  if (settingsDialog.returnValue === 'save') {
    try {
      const patch = {
        javaPath: selectedJavaPath,
        downloadSource: downloadSourceSelect.value,
        downloadConcurrency: Number(downloadConcurrencySelect.value),
        memoryMb: Number(memoryRange.value),
        autoUpdate: autoUpdateCheck.checked
      };
      launcherSettings = settingsApi ? await settingsApi.update(patch) : patch;
      applySettingsToForm();
      const sourceLabel = {
        auto: '自动选择',
        bmclapi: 'BMCLAPI',
        official: 'Mojang 官方'
      }[launcherSettings.downloadSource];
      showToast(`设置已保存：${sourceLabel} · ${launcherSettings.downloadConcurrency} 路线程`);
    } catch (error) {
      showToast(`设置保存失败：${readableError(error)}`);
    }
  }
});

javaSelect.addEventListener('change', async () => {
  if (javaSelect.value === 'auto') {
    selectedJavaPath = '';
    selectedJavaMajorVersion = undefined;
    renderJavaPathSetting();
    return;
  }
  if (!selectedJavaPath && !await chooseJavaPath()) renderJavaPathSetting();
});

javaBrowseButton.addEventListener('click', () => {
  void chooseJavaPath();
});

versionDialog.addEventListener('cancel', (event) => {
  if (versionDownloadActive) {
    // 不阻止关闭：下载在后台继续，用户可通过底部状态条返回
    showToast('下载将在后台继续，点击底部状态条可返回查看');
    return;
  }
  if (versionDeleteActive) {
    event.preventDefault();
  }
});

memoryRange.addEventListener('input', () => {
  memoryValue.value = `${memoryRange.value} MB`;
});

function filterVersionCatalog() {
  const previousVersion = versionCatalog.value;
  renderVersionCatalog();
  if (versionCatalog.value !== previousVersion) {
    loadLoaderCatalog();
  }
}

versionSearch.addEventListener('input', filterVersionCatalog);
versionTypeFilter.addEventListener('change', filterVersionCatalog);
versionCatalog.addEventListener('change', () => loadLoaderCatalog());
loaderTypeSelect.addEventListener('change', () => loadLoaderCatalog());
loaderVersionSelect.addEventListener('change', updateVersionAction);
refreshVersionsButton.addEventListener('click', () => loadVersionCatalog(true));
deleteVersionButton.addEventListener('click', deleteSelectedVersion);
clearVersionSelectionButton.addEventListener('click', clearVersionSelection);
downloadVersionButton.addEventListener('click', installSelectedVersion);
cancelDownloadButton.addEventListener('click', async () => {
  if (!versionDownloadActive || downloadCancelRequested) return;
  downloadCancelRequested = true;
  cancelDownloadButton.disabled = true;
  downloadMessage.textContent = '正在取消下载并清理临时文件…';
  statusBadge.textContent = 'CANCEL';
  try {
    await minecraft?.cancelDownload?.();
  } catch (error) {
    downloadCancelRequested = false;
    cancelDownloadButton.disabled = false;
    showToast(readableError(error));
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
  if (launchRequestActive) return;
  if (selectedProfile && activeGameProfiles.has(selectedProfile)) {
    launchButton.disabled = true;
    launchButton.classList.remove('is-launching');
    launchLabel.textContent = '游戏运行中';
    launchHint.textContent = '等待游戏进程退出';
    return;
  }
  launchButton.disabled = false;
  launchButton.classList.remove('is-launching');
  launchLabel.textContent = '启动游戏';
  launchHint.textContent = selectedProfile ? '准备进入方块世界' : '请先选择已安装版本';
}

if (minecraft?.onLaunchStatus) {
  minecraft.onLaunchStatus((status) => {
    const launchTargetId = status.targetId ?? status.profileId;
    if (status.phase === 'running') {
      activeGameProfiles.add(launchTargetId);
      if (versionSelect.value === launchTargetId) {
        gameStatus.textContent = `${launchTargetId} 正在运行`;
        statusBadge.textContent = 'RUNNING';
      }
    } else if (status.phase === 'authlib-injector') {
      if (versionSelect.value === launchTargetId) {
        gameStatus.textContent = status.message ?? '正在准备 LittleSkin 登录组件';
        statusBadge.textContent = 'YGGDRASIL';
        launchHint.textContent = '校验 authlib-injector';
      }
    } else if (status.phase === 'java') {
      if (versionSelect.value === launchTargetId) {
        gameStatus.textContent = status.message ?? `正在准备 Java ${status.majorVersion ?? ''}`;
        statusBadge.textContent = 'JAVA';
        if (Number.isFinite(status.receivedBytes) && Number.isFinite(status.totalBytes)) {
          const percent = Math.min(100, Math.round(status.receivedBytes / status.totalBytes * 100));
          launchHint.textContent = `自动安装 Java ${status.majorVersion} · ${percent}%`;
        } else {
          launchHint.textContent = `自动准备 Java ${status.majorVersion ?? ''}`;
        }
      }
    } else if (status.phase === 'exited') {
      activeGameProfiles.delete(launchTargetId);
      if (versionSelect.value === launchTargetId) {
        const normalExit = status.code === 0;
        gameStatus.textContent = normalExit
          ? `${launchTargetId} 已退出`
          : `${launchTargetId} 异常退出（${status.code ?? status.signal ?? '未知'}）`;
        statusBadge.textContent = normalExit ? 'READY' : 'ERROR';
        showToast(normalExit ? '游戏已退出' : '游戏进程异常退出');
      }
    }
    updateLaunchButtonState();
  });
}

async function installDroppedModpack(filePath) {
  if (versionDownloadActive || modpackInstallActive) {
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
    const confirmed = window.confirm(
      `安装整合包「${info.name}」？\n\n${formatName} · Minecraft ${info.gameVersion} · ${loaderNames[info.loaderType] ?? info.loaderType}\n需要下载 ${info.fileCount} 个整合包文件。`
    );
    if (!confirmed) return;

    modpackInstallActive = true;
    versionDownloadActive = true;
    downloadCancelRequested = false;
    activeDownloadLabel = info.name;
    cancelDownloadButton.hidden = false;
    cancelDownloadButton.disabled = false;
    downloadStatus.hidden = false;
    gameStatus.textContent = `正在安装整合包 ${info.name}`;
    statusBadge.textContent = 'MODPACK';
    updateDownloadProgress({ phase: 'preparing', message: `正在准备 ${info.name}…` });
    updateVersionAction();

    const result = minecraft?.installModpack
      ? await minecraft.installModpack(filePath)
      : await delay(300).then(() => ({
          name: info.name,
          targetId: `instance-preview-${Date.now()}`
        }));
    await loadLocalProfiles(true);
    useVersion(result.targetId, result.name);
    gameStatus.textContent = `${result.name} 安装完成`;
    statusBadge.textContent = 'SELECTED';
    showToast(`${result.name} 已安装并设为当前游戏`);
  } catch (error) {
    const message = readableError(error);
    const cancelled = downloadCancelRequested || message.includes('下载已取消');
    gameStatus.textContent = cancelled ? '整合包安装已取消' : '整合包安装失败';
    statusBadge.textContent = cancelled ? 'READY' : 'ERROR';
    backgroundDownloadBar.classList.toggle('is-error', !cancelled);
    showToast(cancelled ? '整合包安装已取消' : message);
  } finally {
    modpackInstallActive = false;
    versionDownloadActive = false;
    downloadCancelRequested = false;
    cancelDownloadButton.hidden = true;
    cancelDownloadButton.disabled = false;
    updateVersionAction();
  }
}

let modpackDragDepth = 0;
document.addEventListener('dragenter', (event) => {
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

document.addEventListener('drop', (event) => {
  event.preventDefault();
  modpackDragDepth = 0;
  modpackDropOverlay.hidden = true;
  const file = event.dataTransfer?.files?.[0];
  const filePath = file && filesApi?.getPath ? filesApi.getPath(file) : undefined;
  if (!filePath || !/\.(mrpack|zip)$/i.test(filePath)) {
    showToast('请拖入 Modrinth .mrpack 或 CurseForge .zip 整合包');
    return;
  }
  installDroppedModpack(filePath);
});

launchButton.addEventListener('click', async () => {
  if (!versionSelect.value) {
    showToast('请先安装并选择一个完整的游戏版本');
    return;
  }
  if (!accountState.current) {
    showToast('请先添加并选择一个游戏账户');
    return;
  }
  const profileId = versionSelect.value;
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
        activeGameProfiles.add(profileId);
        gameStatus.textContent = `${profileId} 正在运行`;
        statusBadge.textContent = 'RUNNING';
        return { profileId, pid: 0 };
      });
    showToast(result.pid ? `游戏已启动（PID ${result.pid}）` : '游戏启动参数已生成');
  } catch (error) {
    const message = readableError(error);
    gameStatus.textContent = '游戏启动失败';
    statusBadge.textContent = 'ERROR';
    showToast(message);
  } finally {
    launchRequestActive = false;
    updateLaunchButtonState();
    updateVersionAction();
  }
});

versionSelect.addEventListener('change', () => {
  rememberSelectedGame(versionSelect.value);
  if (versionSelect.value) {
    gameStatus.textContent = `已选择 Minecraft ${versionSelect.value}`;
    statusBadge.textContent = activeGameProfiles.has(versionSelect.value) ? 'RUNNING' : 'SELECTED';
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
      await minecraft.openDirectory();
    } else {
      showToast('Electron 中将打开 .minecraft 游戏目录');
    }
  } catch (error) {
    showToast(readableError(error));
  }
});

if (environment?.versions?.electron) {
  document.querySelector('#electronMeta').textContent = `Electron ${environment.versions.electron}`;
}

loadAccountState();
loadLauncherSettings();
loadLocalProfiles().catch((error) => showToast(`版本检查失败：${readableError(error)}`));
updateLaunchButtonState();
