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
  const expired = "Error invoking remote method 'minecraft:launch-version': Error: Microsoft 登录已移除，请在账户管理中选择离线或 LittleSkin 账户";
  context.showProblem({ message: expired }, '游戏启动失败');
  assert.equal(nodes['#problemTitle'].textContent, '此版本不支持 Microsoft 登录');
  assert.match(nodes['#problemAdvice'].textContent, /离线.*LittleSkin/);
  assert.equal(nodes['#problemAccountButton'].hidden, false);
  assert.equal(nodes['#problemError'].textContent, expired.replace(/^Error invoking remote method '[^']+': Error: /, ''));
  nodes['#problemDetails'].open = true;
  context.showProblem({ message: 'Microsoft 登录服务连接超时' });
  assert.equal(nodes['#problemTitle'].textContent, '无法连接服务');
  assert.equal(nodes['#problemAccountButton'].hidden, true);
  assert.equal(nodes['#problemDetails'].open, false);
  assert.equal(shown, 1);
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
    refreshAutoJavaDetection: async () => { events.push('java-start'); return { available: false }; },
    settingsApi: { detectJava() {} },
    window: { localStorage: { getItem: () => null } },
    JAVA_CHECK_SKIP_KEY: 'java-skip',
    javaCheckDialog: { showModal: () => { throw new Error('Startup must not open a modal'); } },
    showToast: (text) => events.push(text),
    updaterApi: undefined
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function performJavaCheck()'),
    source.indexOf("javaCheckSkipButton.addEventListener")), context);
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
