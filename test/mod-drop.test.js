const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(importModFile = async () => {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/renderer.js'), 'utf8');
  let drop;
  const messages = [], packs = [];
  const context = {
    document: { addEventListener: (_event, callback) => { drop = callback; } },
    modpackDropOverlay: {}, modpackDragDepth: 1,
    filesApi: { getPath: file => file.path }, minecraft: { importModFile },
    versionSelect: { value: 'instance-selected' },
    versionDownloadActive: false, modpackInstallActive: false, launchRequestActive: false,
    showToast: message => messages.push(message), readableError: error => error.message,
    installDroppedModpack: async file => packs.push(file)
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let modImportActive = false;'),
    source.indexOf("launchButton.addEventListener('click'")), context);
  return { context, messages, packs, drop: paths => drop({ preventDefault() {}, dataTransfer: { files: paths.map(path => ({ path })) } }) };
}

test('dropping jars imports every file into the captured selected instance and reports partial errors', async () => {
  const calls = [];
  const f = fixture(async (target, file) => {
    calls.push([target, file]);
    f.context.versionSelect.value = 'other';
    if (file === 'duplicate.jar') throw new Error('同名 Mod 已存在');
  });
  await f.drop(['first.jar', 'duplicate.jar', 'third.JAR']);
  assert.deepEqual(calls, [['instance-selected', 'first.jar'], ['instance-selected', 'duplicate.jar'], ['instance-selected', 'third.JAR']]);
  assert.match(f.messages.at(-1), /已导入 2 个.*1 个失败.*同名/);
  assert.equal(f.context.modpackDropOverlay.hidden, true);
});

test('jar drops require a selected game, reject overlapping tasks, and preserve pack installation', async () => {
  let finish;
  const calls = [];
  const f = fixture(async (...args) => { calls.push(args); await new Promise(resolve => { finish = resolve; }); });
  f.context.versionSelect.value = '';
  await f.drop(['mod.jar']);
  assert.equal(calls.length, 0);
  assert.match(f.messages.at(-1), /先.*选择/);
  f.context.versionSelect.value = 'selected';
  const pending = f.drop(['mod.jar']);
  await f.drop(['second.jar']);
  assert.equal(calls.length, 1);
  assert.match(f.messages.at(-1), /等待当前任务/);
  finish();
  await pending;
  await f.drop(['pack.mrpack']);
  assert.deepEqual(f.packs, ['pack.mrpack']);
  await f.drop(['pack.zip', 'mod.jar']);
  assert.equal(f.packs.length, 1);
  await f.drop(['bad.exe']);
  assert.match(f.messages.at(-1), /请拖入 Mod/);
});
