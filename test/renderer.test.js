const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
