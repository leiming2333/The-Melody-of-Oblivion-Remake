const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../site.js'), 'utf8');
const filename = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';
const asset = { name: filename, size: 4, digest: `sha256:${'a'.repeat(64)}` };
const signedUrl = `https://downloads.melodyoblivion.xyz/releases/v1.9.1/${filename}?expires=9999999999&signature=${'a'.repeat(43)}`;

async function harness({ releaseAsset = asset, enabled = true } = {}) {
  const elements = new Map(), saved = [], objectUrls = [], revoked = [], timers = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const result = {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, dataset: {},
      listeners: {}, attributes: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; if (name === 'value') delete this.value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      querySelector: element, querySelectorAll() { return []; },
      append() {}, replaceChildren() {}, remove() {},
      click() { saved.push({ url: this.href, filename: this.download }); }
    };
    elements.set(id, result);
    return result;
  }
  class BrowserURL extends URL {}
  BrowserURL.createObjectURL = blob => { objectUrls.push(blob); return 'blob:validated'; };
  BrowserURL.revokeObjectURL = url => revoked.push(url);
  const context = vm.createContext({
    document: { documentElement: { lang: 'zh-CN' }, body: element('body'), querySelector: element,
      querySelectorAll: () => [], createElement: tag => element(`${tag}-${elements.size}`), addEventListener() {} },
    window: { addEventListener() {} }, navigator: { platform: 'Win32', language: 'zh-CN' },
    localStorage: { getItem() {}, setItem() {} }, sessionStorage: { getItem() {}, setItem() {} },
    URL: BrowserURL, Blob, AbortController, AbortSignal,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
    fetch: async path => ({ ok: true, json: async () => path === '/api/download-config'
      ? { enabled, siteKey: enabled ? 'site-key' : null, action: 'download' }
      : { tag_name: 'v1.9.1', assets: [releaseAsset] } })
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  let authorizationCalls = 0, downloaderCalls = 0;
  let authorizeImpl = async () => ({ url: signedUrl, expiresAt: new Date(Date.now() + 600000).toISOString() });
  context.loadWebsiteAuthorization = async () => ({ authorizeWebsiteDownload: options => {
    authorizationCalls++; return authorizeImpl(options);
  } });
  const useAuthorization = handler => { authorizeImpl = handler; };
  const useDownloader = handler => {
    context.loadWebsiteDownloader = async () => { downloaderCalls++; return { downloadReleaseAsset: handler }; };
  };
  const click = (extra = {}) => {
    const event = { button: 0, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    return { event, pending: element('#download-button').listeners.click(event) };
  };
  return { context, element, saved, objectUrls, revoked, timers, useAuthorization, useDownloader, click,
    authorizationCalls: () => authorizationCalls, downloaderCalls: () => downloaderCalls };
}

test('human verification must succeed before a single signed CDN source is downloaded', async () => {
  const h = await harness();
  let authorize, request;
  h.useAuthorization(options => {
    assert.equal(options.tag, 'v1.9.1');
    assert.equal(options.asset.name, filename);
    assert.equal(options.container, h.element('#download-turnstile'));
    return new Promise(resolve => { authorize = resolve; });
  });
  h.useDownloader(options => { request = options; return { blob: new Blob(['test']), filename, source: 'Cloudflare CDN' }; });
  const click = h.click();
  await new Promise(setImmediate);
  assert.equal(click.event.prevented, true);
  assert.equal(h.downloaderCalls(), 0);
  assert.equal(h.element('#download-turnstile').hidden, false);
  assert.match(h.element('#download-progress-text').textContent, /真人验证/);
  authorize({ url: signedUrl, expiresAt: new Date(Date.now() + 600000).toISOString() });
  await click.pending;
  assert.equal(h.authorizationCalls(), 1);
  assert.equal(request.autoSelect, false);
  assert.deepEqual(JSON.parse(JSON.stringify(request.sources)), [{ id: 'cloudflare', label: 'Cloudflare CDN', url: signedUrl }]);
  assert.deepEqual(h.saved, [{ url: 'blob:validated', filename }]);
  assert.equal(h.element('#download-button').href, undefined);
  assert.equal(h.element('#download-turnstile').hidden, true);
});

test('only verified files save and language changes preserve progress', async () => {
  const h = await harness();
  let request, finish;
  h.useDownloader(options => { request = options; return new Promise(resolve => { finish = resolve; }); });
  const click = h.click();
  await new Promise(setImmediate);
  assert.equal(h.element('#download-platform').disabled, true);
  await h.click().pending;
  assert.equal(h.downloaderCalls(), 1);
  request.onProgress({ phase: 'downloading', loaded: 4, total: 4, source: 'Cloudflare CDN' });
  assert.equal(h.saved.length, 0);
  request.onProgress({ phase: 'verifying', loaded: 4, total: 4, source: 'Cloudflare CDN' });
  h.context.setLanguage('en');
  assert.match(h.element('#download-progress-text').textContent, /Checking the downloaded file/);
  finish({ blob: new Blob(['test']), filename, source: 'Cloudflare CDN' });
  await click.pending;
  assert.deepEqual(h.saved, [{ url: 'blob:validated', filename }]);
  assert.equal(h.element('#download-platform').disabled, false);
  assert.equal(h.timers[0].delay, 60000);
  h.timers[0].callback();
  assert.deepEqual(h.revoked, ['blob:validated']);
});

test('disabled configuration and untrusted metadata never authorize a download', async () => {
  for (const options of [{ enabled: false }, { releaseAsset: { ...asset, digest: null } }]) {
    const h = await harness(options);
    h.useDownloader(() => { throw new Error('Unexpected download'); });
    await h.click().pending;
    assert.equal(h.authorizationCalls(), 0);
    assert.equal(h.downloaderCalls(), 0);
    assert.deepEqual(h.saved, []);
    assert.equal(h.element('#download-button').href, undefined);
    if (!options.enabled && 'enabled' in options) assert.match(h.element('#download-status').textContent, /暂不可用/);
  }
});

test('authorization failure has no public fallback and a new click revalidates', async () => {
  const h = await harness();
  h.useAuthorization(async () => { throw Object.assign(new Error('Rejected'), { code: 'VERIFICATION_FAILED' }); });
  h.useDownloader(() => { throw new Error('Unexpected download'); });
  await h.click().pending;
  assert.equal(h.downloaderCalls(), 0);
  assert.equal(h.element('#download-button').href, undefined);
  assert.match(h.element('#download-progress-text').textContent, /验证并下载/);
  await h.click().pending;
  assert.equal(h.authorizationCalls(), 2);
  assert.deepEqual(h.saved, []);
});

test('cancel stops authorization and releases controls even while its module is pending', async () => {
  for (const importPending of [true, false]) {
    const h = await harness();
    if (importPending) h.context.loadWebsiteAuthorization = () => new Promise(() => {});
    else h.useAuthorization(() => new Promise(() => {}));
    h.useDownloader(() => { throw new Error('Unexpected download'); });
    const click = h.click();
    await new Promise(setImmediate);
    h.element('#download-cancel').listeners.click();
    await click.pending;
    assert.equal(h.downloaderCalls(), 0);
    assert.deepEqual(h.saved, []);
    assert.equal(h.element('#download-platform').disabled, false);
    assert.equal(h.element('#download-button').disabled, false);
    assert.match(h.element('#download-progress-text').textContent, /已取消/);
  }
});

test('late download completion after cancellation never saves', async () => {
  const h = await harness();
  let finish;
  h.useDownloader(() => new Promise(resolve => { finish = resolve; }));
  const click = h.click();
  await new Promise(setImmediate);
  h.element('#download-cancel').listeners.click();
  finish({ blob: new Blob(['test']), filename, source: 'Cloudflare CDN' });
  await click.pending;
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.objectUrls, []);
});

test('expired authorization blocks new bytes and requests verification again', async () => {
  const h = await harness();
  h.useAuthorization(async () => ({ url: signedUrl, expiresAt: new Date(Date.now() - 1).toISOString() }));
  h.useDownloader(async options => options.fetchImpl(signedUrl, {}));
  await h.click().pending;
  assert.match(h.element('#download-progress-text').textContent, /授权已过期/);
  assert.deepEqual(h.saved, []);
});

test('download HTML has no native CDN or fallback link that can skip verification', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /<button[^>]*id="download-button"[^>]*disabled/);
  assert.doesNotMatch(html, /id="download-source"|id="download-alternative"/);
  assert.match(html, /id="download-turnstile"/);
});
