const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('问题提示提供重新登录入口、保留错误信息并重置上次展开状态', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let shown = 0;
  const nodes = {
    '#problemDialog': { open: false, showModal() { this.open = true; shown++; } },
    '#problemTitle': {}, '#problemMessage': {}, '#problemAdvice': {},
    '#problemError': {}, '#problemDetails': {}, '#problemAccountButton': {}
  };
  const context = { document: { querySelector: (selector) => nodes[selector] } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function readableError('), source.indexOf('function setAccountHint(')), context);
  const expired = "Error invoking remote method 'minecraft:launch-version': Error: AADSTS70000: The grant is expired. The user must sign in again.";
  context.showProblem({ message: expired }, '游戏启动失败');
  assert.equal(nodes['#problemTitle'].textContent, '需要重新登录');
  assert.match(nodes['#problemAdvice'].textContent, /无需先删除.*同步时间/);
  assert.equal(nodes['#problemAccountButton'].hidden, false);
  assert.equal(nodes['#problemError'].textContent, expired.replace(/^Error invoking remote method '[^']+': Error: /, ''));
  nodes['#problemDetails'].open = true;
  context.showProblem({ message: 'Microsoft 登录服务连接超时' });
  assert.equal(nodes['#problemTitle'].textContent, '无法连接服务');
  assert.equal(nodes['#problemAccountButton'].hidden, true);
  assert.equal(nodes['#problemDetails'].open, false);
  assert.equal(shown, 1);
  assert.equal(context.problemGuidance('Microsoft 登录代码已过期，请重新登录').title, '登录代码已过期');
  assert.equal(context.problemGuidance('此 Microsoft 账户未拥有 Minecraft Java 版').account, true);
  assert.equal(context.problemGuidance('Xbox 身份验证失败').account, undefined);
});

function loaderFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const node = () => ({ children: [], append(child) { this.children.push(child); } });
  const select = {
    children: [], disabled: false,
    replaceChildren() { this.children = []; },
    append(child) { this.children.push(child); },
    get options() { return this.children.flatMap((child) => child.children.length ? child.children : [child]); },
    get value() { return (this.options.find((option) => option.selected) ?? this.options[0])?.value ?? ''; },
    set selectedIndex(index) { this.options.forEach((option, i) => { option.selected = i === index; }); }
  };
  let finish;
  const context = {
    document: { createElement: node },
    gameVersion: { id: '1.21.1', installed: false },
    loaderTypeSelect: { value: 'fabric' }, loaderVersionSelect: select,
    loaderVersions: [], loaderLoadToken: 0, loaderCatalogLoading: false,
    localProfiles: [], versionCatalogLoading: false,
    loaderNames: { fabric: 'Fabric', vanilla: 'Vanilla' },
    minecraft: { listLoaders: () => new Promise((resolve) => { finish = resolve; }) },
    selectedRemoteVersion: () => context.gameVersion,
    versionDownloadActive: false, versionDeleteActive: false, versionVerifyActive: false,
    launchRequestActive: false, lastDownloadFailed: false,
    versionSelect: { value: '' }, versionEmpty: {},
    downloadVersionButton: {}, deleteVersionButton: {}, clearVersionSelectionButton: {},
    readableError: (error) => error.message, showToast() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(
    source.indexOf('function selectedLoaderVersion()'),
    source.indexOf('async function verifyLocalVersionsAfterLoad()')
  ), context);
  return { context, finish: (versions) => finish({ versions }) };
}

test('offline avatar follows the selected Steve or Alex skin', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const context = { URL };
  vm.createContext(context);
  vm.runInContext(source.slice(
    source.indexOf('const defaultSkinUrls ='),
    source.indexOf('const selectedGameStorageKey =')
  ), context);
  vm.runInContext(source.slice(
    source.indexOf('function normalizedOnlineSkinUrl('),
    source.indexOf('function rememberSelectedGame(')
  ), context);
  const classes = new Set();
  const avatar = {
    style: {},
    classList: { toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) }
  };
  context.avatar = avatar;
  context.account = { type: 'offline', skinModel: 'steve' };
  vm.runInContext('applySkinAvatar(avatar, account)', context);
  const steveImage = avatar.style.backgroundImage;
  assert.equal(classes.has('is-alex'), false);
  assert.equal(classes.has('has-player-skin'), true);

  context.account.skinModel = 'alex';
  vm.runInContext('applySkinAvatar(avatar, account)', context);
  assert.equal(classes.has('is-alex'), true);
  assert.notEqual(avatar.style.backgroundImage, steveImage);

  context.account.skinModel = 'steve';
  vm.runInContext('applySkinAvatar(avatar, account)', context);
  assert.equal(classes.has('is-alex'), false);
  assert.equal(avatar.style.backgroundImage, steveImage);

  context.account = null;
  vm.runInContext('applySkinAvatar(avatar, account)', context);
  assert.equal(avatar.style.backgroundImage, steveImage);

  context.account = { type: 'microsoft', skinModel: 'alex' };
  vm.runInContext('applySkinAvatar(avatar, account)', context);
  assert.equal(classes.has('is-alex'), true);
  assert.equal(classes.has('has-player-skin'), true);
  assert.notEqual(avatar.style.backgroundImage, steveImage);
});

test('canceling Microsoft login before a device code arrives discards that session', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let resolveBegin;
  const calls = [];
  const context = {
    microsoftLoginButton: {},
    microsoftCancelLoginButton: {},
    microsoftDevicePanel: {},
    microsoftDeviceCode: {},
    microsoftLoginHint: {},
    accountsApi: {
      beginMicrosoft: () => new Promise((resolve) => { resolveBegin = resolve; }),
      completeMicrosoft: () => { calls.push('complete'); },
      cancelMicrosoft: async (id) => { calls.push(['cancel', id]); }
    },
    showToast: () => {}
  };
  vm.createContext(context);
  vm.runInContext('let microsoftLoginSessionId; let microsoftLoginActive = false; let microsoftLoginRequestId = 0;', context);
  vm.runInContext(source.slice(
    source.indexOf('function setMicrosoftLoginBusy('),
    source.indexOf('function setLittleSkinLoginBusy(')
  ), context);
  const pending = vm.runInContext('beginMicrosoftLogin()', context);
  await vm.runInContext('cancelMicrosoftLogin()', context);
  resolveBegin({ sessionId: 'stale-session', userCode: 'ABCD-EFGH' });
  await pending;
  assert.deepEqual(calls, [['cancel', 'stale-session']]);
  assert.equal(context.microsoftDevicePanel.hidden, true);
  assert.equal(context.microsoftLoginButton.disabled, false);
});

test('switching back to vanilla during a loader request restores the action button', async () => {
  const { context, finish } = loaderFixture();
  const pending = context.loadLoaderCatalog();
  assert.equal(context.downloadVersionButton.disabled, true);
  context.loaderTypeSelect.value = 'vanilla';
  await context.loadLoaderCatalog();
  finish([{ version: '0.16.10' }]);
  await pending;
  assert.equal(context.loaderCatalogLoading, false);
  assert.equal(context.downloadVersionButton.disabled, false);
  assert.equal(context.loaderVersionSelect.value, '1.21.1');
});

test('clearing the game selection during a loader request clears the loading state', async () => {
  const { context, finish } = loaderFixture();
  const pending = context.loadLoaderCatalog();
  context.gameVersion = undefined;
  await context.loadLoaderCatalog();
  finish([{ version: '0.16.10' }]);
  await pending;
  assert.equal(context.loaderCatalogLoading, false);
  assert.equal(context.loaderVersions.length, 0);
  assert.equal(context.downloadVersionButton.disabled, true);
});

test('startup paints before background initialization and missing Java stays nonmodal', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const frames = [];
  const timers = [];
  const events = [];
  let showWindow;
  const context = {
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback) => timers.push(callback),
    environment: { diagnostics: {
      markStartup: (stage) => events.push(stage),
      whenWindowShown: () => new Promise((resolve) => { showWindow = resolve; })
    } },
    loadAccountState: async () => events.push('accounts-start'),
    loadLocalProfiles: async () => events.push('profiles-start'),
    loadLauncherSettings: async () => events.push('settings-start'),
    withModpackUi: async () => events.push('modpack-recovery-start'),
    refreshAutoJavaDetection: async () => { events.push('java-start'); return { available: false }; },
    settingsApi: { detectJava() {} },
    window: { localStorage: { getItem: () => null } },
    JAVA_CHECK_SKIP_KEY: 'java-skip',
    showToast: (text) => events.push(text),
    readableError: (error) => error.message,
    updaterApi: undefined
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function performJavaCheck()'),
    source.indexOf('// Paint the home screen')), context);
  vm.runInContext(source.slice(source.indexOf('requestAnimationFrame(() => requestAnimationFrame(async () =>')), context);
  assert.deepEqual(events, []);
  frames.shift()();
  assert.deepEqual(events, []);
  const painted = frames.shift()();
  assert.deepEqual(events, ['renderer-painted']);
  assert.equal(timers.length, 0);
  showWindow();
  await painted;
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.indexOf('renderer-painted') < events.indexOf('java-start'));
  assert.ok(events.some((event) => event.includes('未检测到 Java')));
  assert.ok(events.includes('profiles-loaded'));
  assert.ok(events.includes('java-detected'));
});

test('a game crash displays the saved diagnostic log while normal exit stays nonmodal', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let receive;
  const problems = [];
  const toasts = [];
  const context = {
    minecraft: { onLaunchStatus: (callback) => { receive = callback; } },
    versionSelect: { value: 'game' }, launchRequestActive: false, javaFixActive: false,
    javaReadiness: { status: 'idle' },
    activeGameProfiles: new Set(), gameStatus: {}, statusBadge: {},
    launchButton: { classList: { remove() {} } }, launchLabel: {}, launchHint: {},
    showProblem: (error, title) => problems.push({ message: error.message, title }),
    showToast: (message) => toasts.push(message)
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function updateLaunchButtonState()'),
    source.indexOf('let modpackUiModule;')), context);
  receive({ phase: 'running', targetId: 'game', logPath: '/logs/game.log' });
  assert.equal(context.launchButton.disabled, true);
  receive({ phase: 'exited', targetId: 'game', code: 1, logPath: '/logs/game.log' });
  assert.match(problems[0].message, /异常退出.*1.*\n游戏日志：\/logs\/game.log/);
  assert.equal(context.launchButton.disabled, false);
  receive({ phase: 'exited', targetId: 'game', code: 0, logPath: '/logs/game.log' });
  assert.equal(problems.length, 1);
  assert.deepEqual(toasts, ['游戏已退出']);
  receive({ phase: 'exited', targetId: 'game', signal: 'SIGTERM', logError: 'EACCES' });
  assert.match(problems[1].message, /SIGTERM.*\n游戏日志保存失败（EACCES）/);
});

test('saving once then reopening settings and pressing Esc never saves the new draft', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let onClose;
  const updates = [];
  const dialog = {
    open: false, returnValue: 'save',
    showModal() { this.open = true; },
    addEventListener(_name, callback) { onClose = callback; },
    close(value) {
      if (value !== undefined) this.returnValue = value;
      this.open = false;
      return onClose();
    }
  };
  const context = {
    settingsDialog: dialog, launcherSettingsLoaded: true,
    launcherSettings: { memoryMb: 4096, gameDirectoryMode: 'local' },
    selectedJavaPath: '', savedJavaRuntimes: [],
    wallpaperSelect: { value: '3' }, gameDirectoryModeSelect: { value: 'local' },
    isolateProfilesCheck: { checked: true }, downloadSourceSelect: { value: 'auto' },
    downloadConcurrencySelect: { value: '16' }, memoryRange: { value: '4096' },
    autoUpdateCheck: { checked: true }, launcherUpdatePolicySelect: { value: 'off' },
    settingsApi: { update: async (patch) => { updates.push(patch); return patch; } },
    applySettingsToForm() { context.memoryRange.value = String(context.launcherSettings.memoryMb); },
    showToast() {}, readableError: (error) => error.message
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function ensureSettingsOpen()'),
    source.indexOf('async function openJavaSettings(')), context);
  vm.runInContext(source.slice(source.indexOf("settingsDialog.addEventListener('close'"),
    source.indexOf("gameDirectoryModeSelect.addEventListener('change'")), context);
  await context.ensureSettingsOpen();
  assert.equal(dialog.returnValue, '');
  context.memoryRange.value = '8192';
  await dialog.close('save');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].memoryMb, 8192);

  dialog.returnValue = 'save';
  await context.ensureSettingsOpen();
  assert.equal(dialog.returnValue, '');
  context.memoryRange.value = '6144';
  await context.ensureSettingsOpen();
  assert.equal(context.memoryRange.value, '6144');
  await dialog.close(); // Native Esc closes without replacing returnValue.
  assert.equal(updates.length, 1);
  assert.equal(context.memoryRange.value, '8192');
});

function catalogFixture() {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  function select() {
    return {
      children: [], disabled: false,
      replaceChildren() { this.children = []; },
      append(child) {
        this.children.push(child);
        child.remove = () => { this.children = this.children.filter((item) => item !== child); };
      },
      get options() {
        const options = this.children.flatMap((child) => child.children.length ? child.children : [child]);
        options.forEach((option, index) => { option.index = index; });
        return options;
      },
      get selectedOptions() { return this.options.filter((option) => option.selected); },
      get value() { return this.selectedOptions[0]?.value ?? ''; },
      set value(value) { this.options.forEach((option) => { option.selected = option.value === value; }); },
      set selectedIndex(value) { this.options.forEach((option, index) => { option.selected = index === value; }); }
    };
  }
  const gameSelect = select();
  gameSelect.append({ children: [], selected: true, value: '1.21.1' });
  const context = {
    document: { createElement: () => ({ children: [], append(child) { this.children.push(child); } }) },
    localProfiles: [{ profileId: '1.21.1', type: 'release', valid: true, complete: true, loaderType: 'vanilla' }],
    remoteVersions: [], filteredVersions: [], versionCatalogLoaded: false,
    versionCatalogLoading: false, versionCatalogLoadToken: 0,
    versionCatalog: select(), loaderVersionSelect: select(), versionSelect: gameSelect,
    versionSearch: { value: '' }, versionTypeFilter: { value: 'all' },
    loaderTypeSelect: { value: 'vanilla' }, refreshVersionsButton: {}, versionEmpty: {},
    loaderVersions: [], loaderLoadToken: 0, loaderCatalogLoading: false,
    loaderNames: { vanilla: '原版', fabric: 'Fabric' },
    versionDownloadActive: false, versionDeleteActive: false, versionVerifyActive: false,
    launchRequestActive: false, lastDownloadFailed: false,
    downloadVersionButton: {}, deleteVersionButton: {}, clearVersionSelectionButton: {},
    gameStatus: {}, statusBadge: {}, versionDialog: { close() {} }, versionCloseButtons: [], deleted: [],
    versionTypeName: (type) => type, rememberSelectedGame() {}, updateLaunchButtonState() {},
    refreshJavaReadiness() {},
    loadLocalProfiles: async () => {}, readableError: (error) => error.message,
    showToast() {}, window: { confirm: () => true },
    minecraft: {
      listVersions: async () => { throw new Error('offline'); },
      listLoaders: async () => { throw new Error('offline'); },
      deleteVersion: async (profileId) => { context.deleted.push(profileId); }
    }
  };
  vm.createContext(context);
  for (const [start, end] of [
    ['function selectedRemoteVersion()', 'function renderLocalProfileOptions()'],
    ['function localBaseProfiles()', 'async function verifyLocalVersionsAfterLoad()'],
    ['function renderVersionCatalog(', 'function invalidateVersionCatalogForDirectoryChange()'],
    ['async function loadVersionCatalog(', 'function clearVersionSelection()'],
    ['async function installSelectedVersion()', "wallpaperSelect.addEventListener('change'"]
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  return { context, source };
}

test('the first offline catalog load initializes use and delete for local vanilla and loader profiles', async () => {
  for (const type of ['vanilla', 'fabric']) {
    const { context } = catalogFixture();
    context.loaderTypeSelect.value = type;
    if (type === 'fabric') context.localProfiles.push({
      profileId: 'fabric-loader-0.16.10-1.21.1', inheritsFrom: '1.21.1',
      valid: true, complete: true, loaderType: 'fabric'
    });
    await context.loadVersionCatalog();
    assert.match(context.versionEmpty.textContent, /在线版本加载失败.*offline/);
    assert.equal(context.downloadVersionButton.disabled, false, type);
    assert.equal(context.deleteVersionButton.disabled, false, type);
    assert.equal(context.downloadVersionButton.textContent, '使用此版本');
    const selected = context.selectedLoaderVersion();
    await context.installSelectedVersion();
    assert.equal(context.versionSelect.value, selected.profileId);
    assert.equal(context.statusBadge.textContent, 'SELECTED');
    const profileId = selected.profileId;
    await context.deleteSelectedVersion();
    assert.deepEqual(context.deleted, [profileId]);
    assert.equal(context.localProfiles.some((profile) => profile.profileId === profileId), false);
    assert.equal(context.deleteVersionButton.disabled, true);
    if (type === 'fabric') {
      assert.equal(context.selectedLoaderVersion(), undefined);
      assert.equal(context.downloadVersionButton.disabled, true);
    }
    await context.loadLoaderCatalog();
    assert.equal(context.deleteVersionButton.disabled, true);
  }
});

test('local loader actions survive a failed loader request and merge without duplicates when online returns', async () => {
  const { context } = catalogFixture();
  const profileId = 'fabric-loader-0.16.10-1.21.1';
  context.localProfiles.push({ profileId, inheritsFrom: '1.21.1',
    valid: true, complete: true, loaderType: 'fabric' });
  context.loaderTypeSelect.value = 'fabric';
  await context.loadVersionCatalog();
  await context.loadLoaderCatalog();
  assert.equal(context.downloadVersionButton.disabled, false);
  assert.equal(context.deleteVersionButton.disabled, false);
  context.minecraft.listLoaders = async () => ({ versions: [
    { version: '0.16.10', profileId, installed: true },
    { version: '0.16.11', installed: false }
  ] });
  await context.loadLoaderCatalog(true);
  assert.equal(context.loaderVersions.length, 2);
  assert.equal(context.selectedLoaderVersion().profileId, profileId);
  await context.deleteSelectedVersion();
  assert.equal(context.selectedLoaderVersion().version, '0.16.10');
  assert.equal(context.selectedLoaderVersion().installed, false);
  assert.equal(context.downloadVersionButton.disabled, false);
  assert.equal(context.downloadVersionButton.textContent, '安装 Fabric');
});

function profileOptionsFixture({ profiles = [], remembered = '' } = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const options = [];
  const versionSelect = {
    get options() { return options; },
    value: '',
    replaceChildren() { options.length = 0; },
    append(option) { options.push(option); }
  };
  const rememberedLog = [];
  const context = {
    document: { createElement: () => ({ value: '', textContent: '', disabled: false, hidden: false }) },
    localProfiles: profiles,
    versionSelect,
    gameStatus: {}, statusBadge: {},
    activeGameProfiles: new Set(),
    loaderNames: { vanilla: '原版', fabric: 'Fabric' },
    rememberedSelectedGame: () => remembered,
    rememberSelectedGame: (value) => rememberedLog.push(value),
    updateLaunchButtonState() {}, updateVersionAction() {},
    refreshJavaReadiness() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(
    source.indexOf('function renderLocalProfileOptions()'),
    source.indexOf('async function loadLocalProfiles(')
  ), context);
  return { context, rememberedLog };
}

test('an empty first-run profile list reports no selection instead of a blank chosen version', () => {
  const { context, rememberedLog } = profileOptionsFixture();
  context.renderLocalProfileOptions();
  assert.equal(context.versionSelect.value, '');
  assert.match(context.gameStatus.textContent, /尚无已安装游戏/);
  assert.equal(context.statusBadge.textContent, 'READY');
  assert.deepEqual(rememberedLog, ['']);
});

test('installed profiles still auto-select and honor a remembered selection', () => {
  const { context: auto } = profileOptionsFixture({ profiles: [
    { profileId: '1.21.1', valid: true, complete: true, loaderType: 'vanilla' },
    { profileId: 'fabric-loader-0.16.10-1.21.1', valid: true, complete: true, loaderType: 'fabric' }
  ] });
  auto.renderLocalProfileOptions();
  assert.equal(auto.versionSelect.value, '1.21.1');
  assert.equal(auto.gameStatus.textContent, '已选择 1.21.1');
  assert.equal(auto.statusBadge.textContent, 'SELECTED');

  const { context: remembered } = profileOptionsFixture({ profiles: [
    { profileId: '1.21.1', valid: true, complete: true, loaderType: 'vanilla' },
    { profileId: 'fabric-loader-0.16.10-1.21.1', valid: true, complete: true, loaderType: 'fabric' }
  ], remembered: 'fabric-loader-0.16.10-1.21.1' });
  remembered.renderLocalProfileOptions();
  assert.equal(remembered.versionSelect.value, 'fabric-loader-0.16.10-1.21.1');
  assert.match(remembered.gameStatus.textContent, /^已选择 fabric-loader/);
});

test('launching without a version or account keeps a visible status instead of a fleeting toast', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let handler;
  const toasts = [];
  const context = {
    launchButton: { addEventListener(_name, callback) { handler = callback; } },
    versionSelect: { value: '' },
    accountState: { current: null },
    gameStatus: {}, statusBadge: {}, launchHint: {},
    showToast: (message, isError) => toasts.push({ message, isError }),
    updateVersionAction() {}, updateLaunchButtonState() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(
    source.indexOf("launchButton.addEventListener('click'"),
    source.indexOf("versionSelect.addEventListener('change'")
  ), context);
  await handler();
  assert.equal(context.gameStatus.textContent, '请先安装并选择游戏版本');
  assert.equal(context.statusBadge.textContent, 'READY');
  assert.equal(context.launchHint.textContent, '请先选择已安装版本');
  assert.deepEqual(toasts, [{ message: '请先安装并选择一个完整的游戏版本', isError: true }]);

  context.versionSelect.value = '1.21.1';
  await handler();
  assert.equal(context.gameStatus.textContent, '请先添加并选择游戏账户');
  assert.equal(context.launchHint.textContent, '请先添加游戏账户');
  assert.deepEqual(toasts[1], { message: '请先添加并选择一个游戏账户', isError: true });
});

test('launch hint previews Java readiness for the selected version', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const context = {
    versionSelect: { value: '1.21.1' }, launchRequestActive: false, javaFixActive: false,
    activeGameProfiles: new Set(),
    launchButton: { classList: { remove() {} } }, launchLabel: {}, launchHint: {},
    minecraft: undefined
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function updateLaunchButtonState()'),
    source.indexOf('let modpackUiModule;')), context);

  context.javaReadiness = { status: 'ready', majorVersion: 21 };
  context.updateLaunchButtonState();
  assert.equal(context.launchHint.textContent, 'Java 21 已就绪');

  context.javaReadiness = { status: 'missing', majorVersion: 17 };
  context.updateLaunchButtonState();
  assert.equal(context.launchHint.textContent, '缺少 Java 17 · 可一键下载并启动');

  context.javaReadiness = { status: 'absent', majorVersion: 17 };
  context.updateLaunchButtonState();
  assert.equal(context.launchHint.textContent, '未检测到 Java · 可一键下载并启动');

  context.javaReadiness = { status: 'idle' };
  context.updateLaunchButtonState();
  assert.equal(context.launchHint.textContent, '准备进入方块世界');

  context.versionSelect.value = '';
  context.updateLaunchButtonState();
  assert.equal(context.launchHint.textContent, '请先选择已安装版本');

  context.versionSelect.value = '1.21.1';
  context.javaFixActive = true;
  context.launchHint.textContent = 'Java 21 · 42%';
  context.updateLaunchButtonState();
  assert.equal(context.launchHint.textContent, 'Java 21 · 42%');
});

test('java readiness stays quiet until the environment detection has settled', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const context = {
    versionSelect: { value: '1.21.1' },
    localProfiles: [{ profileId: '1.21.1', requiredJavaVersion: 21, valid: true, complete: true }],
    savedJavaRuntimes: [], autoJavaDetection: null, javaEnvironmentKnown: false,
    updateLaunchButtonState() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(
    source.indexOf('function selectedProfileJavaRequirement()'),
    source.indexOf('async function chooseJavaPath(')
  ), context);

  context.refreshJavaReadiness();
  assert.equal(context.javaReadiness.status, 'idle');

  context.javaEnvironmentKnown = true;
  context.refreshJavaReadiness();
  assert.equal(context.javaReadiness.status, 'absent');
  assert.equal(context.javaReadiness.majorVersion, 21);

  context.savedJavaRuntimes = [{ path: 'C:\\jdk8\\bin\\java.exe', majorVersion: 8 }];
  context.refreshJavaReadiness();
  assert.equal(context.javaReadiness.status, 'missing');
  assert.equal(context.javaReadiness.majorVersion, 21);

  context.autoJavaDetection = { path: 'C:\\jre21\\bin\\java.exe', majorVersion: 21,
    runtimes: [{ path: 'C:\\jre21\\bin\\java.exe', majorVersion: 21 }] };
  context.refreshJavaReadiness();
  assert.equal(context.javaReadiness.status, 'ready');

  context.versionSelect.value = '';
  context.refreshJavaReadiness();
  assert.equal(context.javaReadiness.status, 'idle');
});

test('problem dialog offers a one-click Java fix wired to the download flow', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const fixCalls = [];
  const nodes = {
    '#problemDialog': { open: false, showModal() { this.open = true; }, close() { this.open = false; } },
    '#problemTitle': {}, '#problemMessage': {}, '#problemAdvice': {},
    '#problemError': {}, '#problemDetails': {}, '#problemAccountButton': {},
    '#problemSettingsButton': {}, '#problemRetryButton': {},
    '#problemJavaFixButton': { hidden: true }
  };
  const context = {
    document: { querySelector: (selector) => nodes[selector] },
    downloadJavaAndLaunch: (majorVersion) => fixCalls.push(majorVersion)
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function readableError('),
    source.indexOf('function setAccountHint(')), context);

  context.showProblem(new Error('该游戏版本需要 Java 21，请在设置的 Java 环境旁下载对应运行环境'),
    '游戏启动失败', { javaFix: 21 });
  assert.equal(nodes['#problemJavaFixButton'].hidden, false);
  assert.equal(nodes['#problemJavaFixButton'].textContent, '下载 Java 21 并启动');
  assert.match(nodes['#problemAdvice'].textContent, /自动重试启动/);
  nodes['#problemJavaFixButton'].onclick();
  assert.deepEqual(fixCalls, [21]);
  assert.equal(nodes['#problemDialog'].open, false);

  context.showProblem(new Error('游戏文件校验失败'), '游戏启动失败');
  assert.equal(nodes['#problemJavaFixButton'].hidden, true);
  assert.equal(fixCalls.length, 1);
});

test('a launch failure caused by a missing Java offers the one-click fix dialog', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let handler;
  const problems = [];
  const settingsOpened = [];
  const toasts = [];
  const context = {
    launchButton: { addEventListener(_name, callback) { handler = callback; }, classList: { add() {} } },
    versionSelect: { value: '1.21.1' },
    accountState: { current: { type: 'offline', name: 'Steve' } },
    gameStatus: {}, statusBadge: {}, launchLabel: {}, launchHint: {},
    activeGameProfiles: new Set(),
    minecraft: {
      downloadJava: async () => ({ javaPath: 'C:\\jre21\\bin\\java.exe' }),
      launchVersion: async () => {
        throw new Error('该游戏版本需要 Java 21，请在设置的 Java 环境旁下载对应运行环境');
      }
    },
    showToast: (message) => toasts.push(message),
    readableError: (error) => error.message,
    showProblem: (error, title, options) => problems.push({ message: error.message, title, options }),
    openJavaSettings: (majorVersion) => settingsOpened.push(majorVersion),
    updateVersionAction() {}, updateLaunchButtonState() {}
  };
  vm.createContext(context);
  vm.runInContext(source.slice(
    source.indexOf("launchButton.addEventListener('click'"),
    source.indexOf("versionSelect.addEventListener('change'")
  ), context);

  await handler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(problems.length, 1);
  assert.equal(problems[0].options.javaFix, 21);
  assert.deepEqual(settingsOpened, []);

  context.minecraft = { launchVersion: async () => {
    throw new Error('该游戏版本需要 Java 21，请在设置的 Java 环境旁下载对应运行环境');
  } };
  await handler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(problems.length, 1);
  assert.equal(settingsOpened[0], 21);
  assert.match(toasts.at(-1), /需要 Java 21/);
});

test('one-click Java fix downloads the runtime and relaunches automatically', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let resolveDownload;
  const launches = [];
  const toasts = [];
  const stored = {};
  const refreshCalls = [];
  const context = {
    minecraft: {
      downloadJava: () => new Promise((resolve) => { resolveDownload = resolve; }),
      cancelJavaDownload: async () => ({ cancelled: 1 })
    },
    launchButton: {}, launchLabel: {}, launchHint: {}, gameStatus: {}, statusBadge: {},
    homeCancelDownloadButton: {},
    javaFixActive: false, javaFixMajorVersion: undefined, javaFixTaskId: '',
    javaFixCancelRequested: false, javaDownloadActive: false, launchRequestActive: false,
    versionDownloadActive: false, modpackInstallActive: false, modImportActive: false,
    selectedJavaPath: '', savedJavaRuntimes: [], autoJavaDetectionPromise: null,
    javaEnvironmentKnown: false,
    crypto: { randomUUID: () => 'fix-task-1' },
    window: { localStorage: { setItem: (key, value) => { stored[key] = value; } } },
    JAVA_CHECK_SKIP_KEY: 'java-skip',
    rememberJavaPath() {}, renderJavaPathSetting() {}, renderJavaDownloadState() {},
    applyAutoJavaDetection() {}, refreshJavaReadiness: () => refreshCalls.push('readiness'),
    updateLaunchButtonState() { context.launchButton.disabled = false; },
    launchSelectedVersion: async () => launches.push('relaunch'),
    openJavaSettings() {},
    showToast: (message) => toasts.push(message),
    readableError: (error) => error.message,
    showProblem: () => { throw new Error('problem dialog must not appear on success'); }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(
    source.indexOf('async function downloadJavaAndLaunch('),
    source.indexOf('function setLittleSkinLoginBusy(')
  ), context);

  const pending = context.downloadJavaAndLaunch(21);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.javaFixActive, true);
  assert.equal(context.launchButton.disabled, true);
  assert.equal(context.launchLabel.textContent, '正在下载 Java');
  assert.equal(context.launchHint.textContent, '正在下载 Java 21');
  assert.equal(context.homeCancelDownloadButton.hidden, false);

  resolveDownload({ javaPath: 'C:\\jre21\\bin\\java.exe', majorVersion: 21 });
  await pending;
  assert.equal(context.javaFixActive, false);
  assert.equal(context.homeCancelDownloadButton.hidden, true);
  assert.equal(context.launchButton.disabled, false);
  assert.equal(stored['java-skip'], '1');
  assert.equal(context.javaEnvironmentKnown, true);
  assert.deepEqual(refreshCalls, ['readiness']);
  assert.deepEqual(launches, ['relaunch']);
  assert.match(toasts.at(-1), /Java 21 已就绪，正在启动游戏/);
});

test('a cancelled one-click Java fix keeps the launcher usable without a problem dialog', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  const launches = [];
  const problems = [];
  const toasts = [];
  const context = {
    minecraft: {
      downloadJava: async () => {
        throw Object.assign(new Error('下载已取消'), { code: 'TASK_CANCELLED' });
      },
      cancelJavaDownload: async () => ({ cancelled: 1 })
    },
    launchButton: {}, launchLabel: {}, launchHint: {}, gameStatus: {}, statusBadge: {},
    homeCancelDownloadButton: {},
    javaFixActive: false, javaFixMajorVersion: undefined, javaFixTaskId: '',
    javaFixCancelRequested: false, javaDownloadActive: false, launchRequestActive: false,
    versionDownloadActive: false, modpackInstallActive: false, modImportActive: false,
    selectedJavaPath: '', savedJavaRuntimes: [], autoJavaDetectionPromise: null,
    javaEnvironmentKnown: true,
    crypto: { randomUUID: () => 'fix-task-2' },
    window: { localStorage: { setItem() {} } },
    JAVA_CHECK_SKIP_KEY: 'java-skip',
    rememberJavaPath() {}, renderJavaPathSetting() {}, renderJavaDownloadState() {},
    applyAutoJavaDetection() {}, refreshJavaReadiness() {},
    updateLaunchButtonState() { context.launchButton.disabled = false; },
    launchSelectedVersion: async () => launches.push('relaunch'),
    openJavaSettings() {},
    showToast: (message) => toasts.push(message),
    readableError: (error) => error.message,
    showProblem: (error, title) => problems.push({ error, title })
  };
  vm.createContext(context);
  vm.runInContext(source.slice(
    source.indexOf('async function downloadJavaAndLaunch('),
    source.indexOf('function setLittleSkinLoginBusy(')
  ), context);

  await context.downloadJavaAndLaunch(17);
  assert.deepEqual(launches, []);
  assert.deepEqual(problems, []);
  assert.equal(context.javaFixActive, false);
  assert.equal(context.launchButton.disabled, false);
  assert.match(toasts.at(-1), /已取消 Java 下载/);
});
