const test = require('node:test');
const assert = require('node:assert/strict');

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture(listVersions) {
  const { createFabricApiUi } = await import('../src/renderer/modules/fabric-api-ui.mjs');
  const node = () => ({
    listeners: {}, dataset: {}, children: [], value: '', disabled: false,
    addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); },
    dispatch(name, event = { preventDefault() {} }) {
      return Promise.all((this.listeners[name] ?? []).map((listener) => listener(event)));
    },
    append(option) { this.children.push(option); },
    replaceChildren() { this.children = []; this.value = ''; }
  });
  const dialog = Object.assign(node(), {
    open: false, shows: 0, ownerDocument: { createElement: node },
    showModal() { this.open = true; this.shows += 1; },
    close() { this.open = false; void this.dispatch('close'); }
  });
  const elements = { dialog, target: node(), includeApi: node(), versionSelect: node(),
    status: node(), retryButton: node(), installButton: node(), skipButton: node(),
    cancelButtons: [node(), node()] };
  const requests = [];
  const ui = createFabricApiUi({ elements, minecraft: {
    listFabricApiVersions: (version, options) => { requests.push({ version, options }); return listVersions(version, options); }
  } });
  return { ui, elements, requests };
}

const api = (id, versionType, datePublished) => ({ id, version: id, versionType, datePublished });
const response = (versions, gameVersion = '1.21.1') => ({ gameVersion, versions });
const target = { gameVersion: '1.21.1', loaderVersion: '0.18.0' };

test('Fabric API confirmation waits for compatible versions and defaults to the latest stable release', async () => {
  const query = deferred();
  const { ui, elements, requests } = await fixture(() => query.promise);
  const answer = ui.confirm(target);
  assert.equal(elements.dialog.open, true);
  assert.match(elements.target.textContent, /1\.21\.1.*0\.18\.0/);
  assert.equal(elements.installButton.disabled, true);
  assert.equal(elements.versionSelect.disabled, true);
  query.resolve(response([
    api('old-release', 'release', '2026-01-01'),
    api('beta', 'beta', '2026-10-31'),
    api('latest-release', 'release', '2026-10-30')
  ]));
  await flush();
  assert.equal(elements.versionSelect.value, 'latest-release');
  assert.equal(elements.installButton.disabled, false);
  assert.equal(requests[0].version, '1.21.1');
  elements.versionSelect.value = 'old-release';
  await elements.versionSelect.dispatch('change');
  await elements.installButton.dispatch('click');
  assert.deepEqual(await answer, { fabricApiVersionId: 'old-release' });
  assert.equal(elements.dialog.open, false);
});

test('a failed API query can be retried with a fresh request without starting installation', async () => {
  let attempt = 0;
  const { ui, elements, requests } = await fixture(async () => {
    if (++attempt === 1) throw new Error('network unavailable');
    return response([api('release', 'release', '2026-10-31')]);
  });
  const answer = ui.confirm(target);
  await flush();
  assert.equal(elements.status.dataset.state, 'error');
  assert.match(elements.status.textContent, /network unavailable.*重试.*仅安装/);
  assert.equal(elements.installButton.disabled, true);
  assert.equal(elements.retryButton.hidden, false);
  await elements.retryButton.dispatch('click');
  await flush();
  assert.equal(requests[1].options.force, true);
  assert.equal(elements.installButton.disabled, false);
  await elements.installButton.dispatch('click');
  assert.deepEqual(await answer, { fabricApiVersionId: 'release' });
});

test('no compatible API requires an explicit skip or unchecked option', async () => {
  for (const skip of [true, false]) {
    const { ui, elements } = await fixture(async () => response([]));
    const answer = ui.confirm(target);
    await flush();
    assert.equal(elements.status.dataset.state, 'empty');
    assert.match(elements.status.textContent, /没有适用于 Minecraft 1\.21\.1/);
    assert.equal(elements.installButton.disabled, true);
    if (skip) await elements.skipButton.dispatch('click');
    else {
      elements.includeApi.checked = false;
      await elements.includeApi.dispatch('change');
      assert.equal(elements.installButton.disabled, false);
      await elements.installButton.dispatch('click');
    }
    assert.deepEqual(await answer, { fabricApiVersionId: null });
  }
});

test('API lookup failures and pending requests allow an explicit Fabric-only installation', async () => {
  for (const query of [async () => { throw new Error('timeout'); }, () => new Promise(() => {})]) {
    const { ui, elements } = await fixture(query);
    const answer = ui.confirm(target);
    await flush();
    await elements.skipButton.dispatch('click');
    assert.deepEqual(await answer, { fabricApiVersionId: null });
  }
});

test('Esc, close, cancel controls and programmatic invalidation cancel the whole confirmation', async () => {
  for (const cancel of ['escape', 'close', 'button', 'header', 'invalidate']) {
    const query = deferred();
    const { ui, elements } = await fixture(() => query.promise);
    const answer = ui.confirm(target);
    if (cancel === 'escape') {
      let prevented = false;
      await elements.dialog.dispatch('cancel', { preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    } else if (cancel === 'close') elements.dialog.close();
    else if (cancel === 'invalidate') ui.cancel();
    else await elements.cancelButtons[cancel === 'header' ? 0 : 1].dispatch('click');
    assert.equal(await answer, null);
    assert.equal(elements.dialog.open, false);
    query.resolve(response([api('late', 'release', '2026-10-31')]));
    await flush();
    assert.equal(elements.versionSelect.children.length, 0);
  }
});

test('responses from an abandoned confirmation cannot overwrite a later game selection', async () => {
  const first = deferred(), second = deferred();
  let attempt = 0;
  const { ui, elements } = await fixture(() => (++attempt === 1 ? first.promise : second.promise));
  const obsolete = ui.confirm(target);
  const current = ui.confirm({ ...target, gameVersion: '1.21.2' });
  assert.equal(await obsolete, null);
  second.resolve(response([api('right-game', 'release', '2026-10-30')], '1.21.2'));
  await flush();
  first.resolve(response([api('old-game', 'release', '2026-10-31')]));
  await flush();
  assert.equal(elements.versionSelect.value, 'right-game');
  assert.equal(elements.versionSelect.children.length, 1);
  await elements.installButton.dispatch('click');
  assert.deepEqual(await current, { fabricApiVersionId: 'right-game' });
});

test('invalid or mismatched API responses show a recoverable failure and preview-only releases are labeled', async () => {
  for (const invalid of [null, response(null), response([{ id: '' }]), response([], 'other-game')]) {
    const { ui, elements } = await fixture(async () => invalid);
    const answer = ui.confirm(target);
    await flush();
    assert.equal(elements.status.dataset.state, 'error');
    assert.equal(elements.installButton.disabled, true);
    ui.cancel();
    assert.equal(await answer, null);
  }
  const { ui, elements } = await fixture(async () => response([api('beta', 'beta', '2026-10-31')]));
  const answer = ui.confirm(target);
  await flush();
  assert.match(elements.status.textContent, /仅有预览版本/);
  assert.match(elements.versionSelect.children[0].textContent, /测试版/);
  ui.cancel();
  await answer;
});

test('reopening after cancellation resets the choice and ignores a queued close event and the old query', async () => {
  const oldQuery = deferred();
  let attempt = 0;
  const { ui, elements } = await fixture(() => (++attempt === 1 ? oldQuery.promise
    : Promise.resolve(response([api('current', 'release', '2026-10-31')]))));
  const oldAnswer = ui.confirm(target);
  elements.includeApi.checked = false;
  await elements.includeApi.dispatch('change');
  ui.cancel();
  assert.equal(await oldAnswer, null);
  const reopened = ui.confirm(target);
  // Native dialog.close() queues this event; it may arrive after a new showModal().
  await elements.dialog.dispatch('close');
  await flush();
  oldQuery.resolve(response([api('obsolete', 'release', '2026-11-01')]));
  await flush();
  assert.equal(elements.dialog.open, true);
  assert.equal(elements.includeApi.checked, true);
  assert.equal(elements.versionSelect.value, 'current');
  await elements.installButton.dispatch('click');
  assert.deepEqual(await reopened, { fabricApiVersionId: 'current' });
});

test('changing API selection and toggling the checkbox preserves a valid choice and rejects an empty selection', async () => {
  const { ui, elements } = await fixture(async () => response([
    api('latest', 'release', '2026-10-31'), api('older', 'release', '2026-10-30')
  ]));
  const answer = ui.confirm(target);
  await flush();
  elements.versionSelect.value = 'older';
  await elements.versionSelect.dispatch('change');
  elements.includeApi.checked = false;
  await elements.includeApi.dispatch('change');
  assert.equal(elements.versionSelect.disabled, true);
  assert.equal(elements.installButton.disabled, false);
  elements.includeApi.checked = true;
  await elements.includeApi.dispatch('change');
  assert.equal(elements.versionSelect.value, 'older');
  assert.equal(elements.versionSelect.disabled, false);
  elements.versionSelect.value = '';
  await elements.versionSelect.dispatch('change');
  assert.equal(elements.installButton.disabled, true);
  elements.versionSelect.value = 'older';
  await elements.versionSelect.dispatch('change');
  await elements.installButton.dispatch('click');
  assert.deepEqual(await answer, { fabricApiVersionId: 'older' });
});
