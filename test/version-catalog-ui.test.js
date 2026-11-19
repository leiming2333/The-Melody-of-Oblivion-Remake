const test = require('node:test');
const assert = require('node:assert/strict');
const { createVersionCatalogUi } = require('../src/renderer/modules/version-catalog-ui');

function fixture() {
  function select() {
    return {
      children: [], disabled: false,
      replaceChildren() { this.children = []; },
      append(child) { this.children.push(child); },
      get options() {
        const options = this.children.flatMap((child) => child.children?.length ? child.children : [child]);
        options.forEach((option, index) => { option.index = index; });
        return options;
      },
      get selectedOptions() { return this.options.filter((option) => option.selected); },
      get value() { return this.selectedOptions[0]?.value ?? ''; },
      set value(value) { this.options.forEach((option) => { option.selected = option.value === value; }); },
      set selectedIndex(value) { this.options.forEach((option, index) => { option.selected = index === value; }); }
    };
  }
  const state = {
    remoteVersions: [], filteredVersions: [], localProfiles: [], loaderVersions: [],
    versionCatalogLoadToken: 0, loaderLoadToken: 0, versionCatalogLoaded: false,
    versionCatalogLoading: false, loaderCatalogLoading: false
  };
  const context = {
    state,
    document: { createElement: () => ({ children: [], append(child) { this.children.push(child); } }) },
    versionCatalog: select(), versionSelect: { value: '' },
    versionSearch: { value: '' }, versionTypeFilter: { value: 'all' },
    loaderTypeSelect: { value: 'vanilla' }, loaderVersionSelect: select(),
    loaderNames: { vanilla: '原版', fabric: 'Fabric' },
    versionEmpty: {}, versionSelectionSummary: {}, refreshVersionsButton: {},
    downloadVersionButton: {}, addFabricApiButton: {}, deleteVersionButton: {}, clearVersionSelectionButton: {},
    versionTypeName: (type) => ({ release: '正式版', snapshot: '快照版' }[type] ?? type),
    readableError: (error) => error.message, showToast() {},
    refreshLocalProfiles: async () => {},
    minecraft: {
      listVersions: async () => ({ versions: state.remoteVersions }),
      listLoaders: async () => ({ versions: [] })
    }
  };
  return { state, context, ui: createVersionCatalogUi(context) };
}

test('版本筛选支持已安装加载器的基础版本和全部远古版本', () => {
  const { state, context, ui } = fixture();
  state.remoteVersions = [
    { id: '1.21', type: 'release', installed: true },
    { id: '1.20', type: 'release' },
    { id: 'b1.7', type: 'old_beta' },
    { id: 'a1.2', type: 'old_alpha' },
    { id: '1.19', type: 'release' }
  ];
  state.localProfiles = [
    { profileId: 'fabric-1.20', inheritsFrom: '1.20', valid: true, complete: true, loaderType: 'fabric' },
    { profileId: 'pack-1.19', inheritsFrom: '1.19', valid: true, complete: true, isInstance: true }
  ];
  context.versionTypeFilter.value = 'installed';
  ui.renderVersionCatalog();
  assert.deepEqual(state.filteredVersions.map((version) => version.id), ['1.21', '1.20']);
  assert.match(context.versionCatalog.options.find((option) => option.value === '1.20').textContent, /已装加载器/);

  context.versionTypeFilter.value = 'old';
  ui.renderVersionCatalog();
  assert.deepEqual(state.filteredVersions.map((version) => version.id), ['b1.7', 'a1.2']);
});

test('搜索将精确版本和同系列排在前面，同时保留可辨识的安装状态', () => {
  const { state, context, ui } = fixture();
  state.remoteVersions = [
    { id: '1.20.6', type: 'release', installed: true },
    { id: 'old-1.2', type: 'old_beta' },
    { id: '1.2.5', type: 'release' },
    { id: '1.2', type: 'release' }
  ];
  context.versionSearch.value = ' 1.2 ';
  ui.renderVersionCatalog();
  assert.deepEqual(context.versionCatalog.options.map((option) => option.value), ['1.2', '1.2.5', '1.20.6', 'old-1.2']);
  assert.equal(context.versionCatalog.value, '1.2');
  assert.match(context.versionCatalog.options[2].textContent, /已安装/);
});

test('最新标识取自完整在线列表，待修复和仅本地文件具有不同操作状态', async () => {
  const { state, context, ui } = fixture();
  state.remoteVersions = [
    { id: '1.20', type: 'release', releaseTime: '2023-06-07', installed: true },
    { id: '1.21', type: 'release', releaseTime: '2024-06-13', localFilesPresent: true, complete: false },
    { id: '24w20a', type: 'snapshot', releaseTime: '2024-05-15' },
    { id: '24w30a', type: 'snapshot', releaseTime: '2024-07-24' },
    { id: 'custom', type: 'release', releaseTime: '2030-01-01', localOnly: true, localFilesPresent: true, complete: false }
  ];
  context.versionTypeFilter.value = 'release';
  ui.renderVersionCatalog('1.21');
  await ui.loadLoaderCatalog();
  const newest = context.versionCatalog.options.find((option) => option.value === '1.21');
  assert.match(newest.textContent, /最新正式版.*待修复/);
  assert.match(context.versionSelectionSummary.textContent, /Minecraft 1.21.*文件不完整/);
  assert.equal(context.downloadVersionButton.textContent, '补齐游戏文件');
  assert.equal(context.downloadVersionButton.disabled, false);
  assert.equal(context.versionCatalog.options.find((option) => option.value === 'custom').disabled, true);

  context.versionSearch.value = '1.20';
  ui.renderVersionCatalog();
  assert.doesNotMatch(context.versionCatalog.options[0].textContent, /最新正式版/);
  context.versionSearch.value = '';
  context.versionTypeFilter.value = 'snapshot';
  ui.renderVersionCatalog();
  assert.match(context.versionCatalog.options.find((option) => option.value === '24w30a').textContent, /最新快照/);
  assert.doesNotMatch(context.versionCatalog.options.find((option) => option.value === '24w20a').textContent, /最新快照/);
});

test('在线刷新和晚到的本地扫描不会抢回首页版本或覆盖用户当前选择', async () => {
  const { state, context, ui } = fixture();
  const versions = ['1.21', '1.20', '1.19'].map((id) => ({ id, type: 'release' }));
  state.remoteVersions = versions;
  state.versionCatalogLoaded = true;
  context.versionSelect.value = '1.21';
  ui.renderVersionCatalog('1.20');
  let finishOnline, finishLocal;
  context.minecraft.listVersions = () => new Promise((resolve) => { finishOnline = resolve; });
  context.refreshLocalProfiles = () => new Promise((resolve) => { finishLocal = resolve; });
  const pending = ui.loadVersionCatalog(true);
  await new Promise((resolve) => setImmediate(resolve));
  context.versionCatalog.value = '1.19';
  finishOnline({ versions });
  await pending;
  assert.equal(context.versionCatalog.value, '1.19');
  context.versionCatalog.value = '1.20';
  finishLocal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.versionCatalog.value, '1.20');
});

test('安装时锁定加载器选择，结束后恢复，空加载器列表保持禁用', async () => {
  const { state, context, ui } = fixture();
  state.remoteVersions = [{ id: '1.21', type: 'release' }];
  context.loaderTypeSelect.value = 'fabric';
  state.loaderVersions = [{ version: '0.16.10', installed: false }];
  ui.renderVersionCatalog();
  ui.renderLoaderCatalog();
  assert.equal(context.loaderTypeSelect.disabled, false);
  assert.equal(context.loaderVersionSelect.disabled, false);
  state.versionDownloadActive = true;
  ui.updateVersionAction();
  assert.equal(context.loaderTypeSelect.disabled, true);
  assert.equal(context.loaderVersionSelect.disabled, true);
  assert.equal(context.downloadVersionButton.textContent, '正在安装');
  assert.match(context.versionSelectionSummary.textContent, /Fabric 0.16.10.*正在安装/);
  state.versionDownloadActive = false;
  ui.updateVersionAction();
  assert.equal(context.loaderTypeSelect.disabled, false);
  assert.equal(context.loaderVersionSelect.disabled, false);
  await ui.loadLoaderCatalog();
  assert.equal(context.loaderVersionSelect.disabled, true);
  assert.equal(context.downloadVersionButton.disabled, true);
});

test('Fabric API 入口仅随 Fabric 显示，已安装时允许添加，确认与安装期间禁用', () => {
  const { state, context, ui } = fixture();
  state.remoteVersions = [{ id: '1.21.1', type: 'release' }];
  ui.renderVersionCatalog();
  assert.equal(context.addFabricApiButton.hidden, true);
  context.loaderTypeSelect.value = 'fabric';
  state.loaderVersions = [{ version: '0.18.0', installed: false }];
  ui.renderLoaderCatalog();
  assert.equal(context.addFabricApiButton.hidden, false);
  assert.equal(context.addFabricApiButton.disabled, false);
  assert.equal(context.addFabricApiButton.textContent, '选择 Fabric API');
  state.loaderVersions[0].installed = true;
  state.loaderVersions[0].profileId = 'existing-fabric-profile';
  ui.updateVersionAction();
  assert.equal(context.addFabricApiButton.textContent, '添加 Fabric API');
  assert.equal(context.addFabricApiButton.disabled, false);
  state.fabricApiConfirmationActive = true;
  ui.updateVersionAction();
  assert.equal(context.addFabricApiButton.disabled, true);
  state.fabricApiConfirmationActive = false;
  state.versionDownloadActive = true;
  ui.updateVersionAction();
  assert.equal(context.addFabricApiButton.disabled, true);
  state.versionDownloadActive = false;
  ui.updateVersionAction();
  assert.equal(context.addFabricApiButton.disabled, false);
  context.loaderTypeSelect.value = 'forge';
  ui.updateVersionAction();
  assert.equal(context.addFabricApiButton.hidden, true);
});

test('本地缺失原版但加载器可用时仅允许使用已安装加载器', async () => {
  const { state, context, ui } = fixture();
  state.remoteVersions = [{ id: 'custom', type: 'release', localOnly: true, localFilesPresent: true, complete: false }];
  state.localProfiles = [{ profileId: 'fabric-custom', inheritsFrom: 'custom', valid: true, complete: true, loaderType: 'fabric' }];
  context.versionTypeFilter.value = 'installed';
  ui.renderVersionCatalog();
  assert.equal(context.versionCatalog.options[0].disabled, false);
  await ui.loadLoaderCatalog();
  assert.equal(context.downloadVersionButton.disabled, true);
  context.loaderTypeSelect.value = 'fabric';
  await ui.loadLoaderCatalog();
  assert.equal(context.downloadVersionButton.disabled, false);
  assert.equal(context.downloadVersionButton.textContent, '使用此版本');
});

test('安装开始后旧在线刷新不替换安装对象，也不能重新解锁目录控件', async () => {
  for (const finishAfterInstallation of [false, true]) {
    const { state, context, ui } = fixture();
    state.remoteVersions = [{ id: '1.21', type: 'release' }];
    state.versionCatalogLoaded = true;
    ui.renderVersionCatalog();
    await ui.loadLoaderCatalog();
    let finishOnline;
    let onlineRequests = 0;
    context.minecraft.listVersions = () => {
      onlineRequests += 1;
      return new Promise((resolve) => { finishOnline = resolve; });
    };
    context.refreshLocalProfiles = () => new Promise(() => {});
    const pending = ui.loadVersionCatalog(true);
    const installingVersion = ui.selectedRemoteVersion();
    const installingLoader = ui.selectedLoaderVersion();
    state.versionDownloadActive = true;
    context.versionCatalog.disabled = true;
    context.versionSearch.disabled = true;
    context.versionTypeFilter.disabled = true;
    ui.updateVersionAction();
    await ui.loadVersionCatalog(true);
    await ui.loadLoaderCatalog(true);
    assert.equal(onlineRequests, 1, '安装中不会开始新的目录请求');
    assert.equal(context.versionCatalog.disabled, true);
    assert.equal(context.versionSearch.disabled, true);
    assert.equal(context.versionTypeFilter.disabled, true);
    assert.equal(context.refreshVersionsButton.disabled, true);
    assert.equal(ui.selectedLoaderVersion(), installingLoader);
    if (finishAfterInstallation) {
      installingVersion.installed = true;
      installingLoader.installed = true;
      state.versionDownloadActive = false;
      ui.updateVersionAction();
    }
    finishOnline({ versions: [{ id: '1.21', type: 'release' }] });
    await pending;
    assert.equal(ui.selectedRemoteVersion(), installingVersion);
    assert.equal(ui.selectedLoaderVersion(), installingLoader);
    assert.equal(context.refreshVersionsButton.disabled, !finishAfterInstallation);
    assert.equal(context.downloadVersionButton.textContent, finishAfterInstallation ? '使用此版本' : '正在安装');
  }
});

test('安装开始后旧加载器请求和本地扫描即使更晚返回也不会覆盖结果', async () => {
  const { state, context, ui } = fixture();
  state.remoteVersions = [{ id: '1.21', type: 'release' }];
  state.localProfiles = [{ profileId: 'fabric-local', inheritsFrom: '1.21', valid: true, complete: true, loaderType: 'fabric' }];
  context.loaderTypeSelect.value = 'fabric';
  ui.renderVersionCatalog();
  let finishLoaders, finishScan;
  context.minecraft.listLoaders = () => new Promise((resolve) => { finishLoaders = resolve; });
  const loaders = ui.loadLoaderCatalog(true);
  const installingLoader = ui.selectedLoaderVersion();
  state.localProfilesLoadToken = 0;
  context.minecraft.listLocalVersions = () => new Promise((resolve) => { finishScan = resolve; });
  let profileRenders = 0;
  context.renderProfiles = () => { profileRenders += 1; };
  const profiles = ui.loadLocalProfiles(true);
  state.versionDownloadActive = true;
  ui.updateVersionAction();
  state.versionDownloadActive = false;
  ui.updateVersionAction();
  finishLoaders({ versions: [{ version: 'newest', installed: false }] });
  finishScan({ profiles: [], gameDirectory: 'old-scan' });
  await Promise.all([loaders, profiles]);
  assert.equal(ui.selectedLoaderVersion(), installingLoader);
  assert.equal(state.localProfiles.length, 1);
  assert.equal(profileRenders, 0);
  assert.equal(context.downloadVersionButton.textContent, '使用此版本');
});
