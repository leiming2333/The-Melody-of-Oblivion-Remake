const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../site.js'), 'utf8');
const filename = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';
const asset = { name: filename, size: 4, digest: `sha256:${'a'.repeat(64)}`,
  browser_download_url: `https://fixture.public.blob.vercel-storage.com/releases/v1.9.1/${filename}` };

async function harness({ releaseAsset = asset, savedSource } = {}) {
  const elements = new Map();
  const saved = [], objectUrls = [], revoked = [], timers = [];
  const storage = new Map(savedSource ? [['melody-site-download-source', savedSource]] : []);
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const result = {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, dataset: {},
      listeners: {}, attributes: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; if (name === 'value') delete this.value; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      querySelector(selector) { return element(selector); }, querySelectorAll() { return []; },
      append() {}, replaceChildren() {}, remove() {},
      click() { saved.push({ url: this.href, filename: this.download }); }
    };
    elements.set(id, result);
    return result;
  }
  const select = element('#download-source');
  select.options = ['auto', 'cloudflare', 'blob', 'ghproxy', 'ghfast', 'gh-proxy', 'official'].map(value => ({ value, textContent: value }));
  select.value = 'auto';
  Object.defineProperty(select, 'selectedOptions', { get: () => select.options.filter(option => option.value === select.value) });
  const blobOption = element('option[value="blob"]');
  blobOption.dataset.i18n = 'download.blob';
  blobOption.innerHTML = 'Vercel Blob（香港）';
  const cloudflareOption = element('option[value="cloudflare"]');
  cloudflareOption.dataset.i18n = 'download.cloudflare';
  cloudflareOption.innerHTML = 'Cloudflare CDN';
  class BrowserURL extends URL {}
  BrowserURL.createObjectURL = blob => { objectUrls.push(blob); return 'blob:validated'; };
  BrowserURL.revokeObjectURL = url => revoked.push(url);
  const context = vm.createContext({
    document: { documentElement: { lang: 'zh-CN' }, body: element('body'),
      querySelector: element, querySelectorAll: () => [blobOption, cloudflareOption], createElement: tag => element(`${tag}-${elements.size}`),
      addEventListener() {} },
    window: { addEventListener() {} }, navigator: { platform: 'Win32', language: 'zh-CN' },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    sessionStorage: { getItem() {}, setItem() {} }, URL: BrowserURL, Blob, AbortController,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); },
    fetch: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.9.1', assets: [releaseAsset] }) })
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  let calls = 0;
  const useDownloader = downloadReleaseAsset => {
    context.loadWebsiteDownloader = async () => { calls += 1; return { downloadReleaseAsset }; };
  };
  const click = (extra = {}) => {
    const event = { button: 0, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
    return { event, pending: element('#download-button').listeners.click(event) };
  };
  return { context, element, select, saved, objectUrls, revoked, timers, storage, useDownloader, click, calls: () => calls };
}

test('website saves only after verification resolves and keeps progress when switching language', async () => {
  const h = await harness();
  let request, finish;
  h.useDownloader(options => { request = options; return new Promise(resolve => { finish = resolve; }); });
  const click = h.click();
  await new Promise(setImmediate);
  assert.equal(click.event.prevented, true);
  assert.equal(h.select.disabled, true);
  assert.equal(h.element('#download-platform').disabled, true);
  assert.equal((await h.click().pending), undefined);
  assert.equal(h.calls(), 1);
  request.onProgress({ phase: 'downloading', loaded: 4, total: 4, source: 'Vercel Blob' });
  assert.equal(h.saved.length, 0, '100% transfer is not a verified download');
  request.onProgress({ phase: 'verifying', loaded: 4, total: 4, source: 'Vercel Blob' });
  h.context.setLanguage('en');
  assert.match(h.element('#download-progress-text').textContent, /Checking the downloaded file/);
  assert.equal(h.element('#download-progress').value, 100);
  assert.equal(h.saved.length, 0);
  finish({ blob: new Blob(['test']), filename, source: 'Vercel Blob' });
  await click.pending;
  assert.deepEqual(h.saved, [{ url: 'blob:validated', filename }]);
  assert.equal(h.select.disabled, false);
  assert.match(h.element('#download-progress-text').textContent, /File verified/);
  assert.equal(h.timers[0].delay, 60000);
  assert.deepEqual(h.revoked, []);
  h.timers[0].callback();
  assert.deepEqual(h.revoked, ['blob:validated']);
});

test('cancellation prevents saving even if the downloader resolves after abort', async () => {
  const h = await harness();
  let request, finish;
  h.useDownloader(options => { request = options; return new Promise(resolve => { finish = resolve; }); });
  const click = h.click();
  await new Promise(setImmediate);
  h.element('#download-cancel').listeners.click();
  assert.equal(request.signal.aborted, true);
  finish({ blob: new Blob(['test']), filename, source: 'Vercel Blob' });
  await click.pending;
  assert.deepEqual(h.saved, []);
  assert.deepEqual(h.objectUrls, []);
  assert.match(h.element('#download-progress-text').textContent, /已取消/);
  assert.equal(h.select.disabled, false);
});

test('cancellation releases the controls while the first module import is still pending', async () => {
  const h = await harness();
  h.context.loadWebsiteDownloader = () => new Promise(() => {});
  const click = h.click();
  h.element('#download-cancel').listeners.click();
  await click.pending;
  assert.equal(h.select.disabled, false);
  assert.equal(h.element('#download-platform').disabled, false);
  assert.equal(h.element('#download-button').attributes['aria-disabled'], 'false');
  assert.match(h.element('#download-progress-text').textContent, /已取消/);
  assert.deepEqual(h.saved, []);
});

test('untrusted metadata never loads the downloader or saves a file', async () => {
  const h = await harness({ releaseAsset: { ...asset, digest: null } });
  h.useDownloader(() => { throw new Error('Unexpected download'); });
  const click = h.click();
  await click.pending;
  assert.equal(click.event.prevented, true);
  assert.equal(h.calls(), 0);
  assert.deepEqual(h.saved, []);
  assert.match(h.element('#download-progress-text').textContent, /备用直链/);
  assert.equal(h.element('#download-alternative').hidden, false);
});

test('official and modified clicks keep native browser navigation', async () => {
  const h = await harness();
  for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey']) {
    const click = h.click({ [modifier]: true });
    await click.pending;
    assert.equal(click.event.prevented, false);
  }
  h.select.value = 'official';
  h.select.listeners.change();
  const click = h.click();
  await click.pending;
  assert.equal(click.event.prevented, false);
  assert.match(h.element('#download-button-label').textContent, /浏览器/);
  assert.equal(h.storage.get('melody-site-download-source'), 'official');
  assert.equal(h.calls(), 0);
});

test('manual sources stay first, failed verification does not save, and selection clears errors', async () => {
  const h = await harness({ savedSource: 'ghfast' });
  assert.equal(h.select.value, 'ghfast');
  h.useDownloader(async options => {
    assert.equal(options.autoSelect, false);
    assert.equal(options.sources[0].id, 'ghfast');
    assert.equal(options.sources.some(candidate => new URL(candidate.url).hostname === 'github.com'), false);
    options.onProgress({ phase: 'verifying', loaded: 4, total: 4, source: 'ghfast.top' });
    throw Object.assign(new Error('bad bytes'), { code: 'CHECKSUM_MISMATCH' });
  });
  await h.click().pending;
  assert.deepEqual(h.saved, []);
  assert.match(h.element('#download-progress-text').textContent, /下载未完成/);
  h.select.value = 'auto';
  h.select.listeners.change();
  assert.equal(h.element('#download-progress-panel').hidden, true);
  assert.equal(h.storage.get('melody-site-download-source'), 'auto');
  const unknown = await harness({ savedSource: 'https://untrusted.example' });
  assert.equal(unknown.select.value, 'auto');
});

test('Cloudflare joins automatic source selection and remains the native browser fallback', async () => {
  const cdnUrl = `https://cdn.example.test/releases/v1.9.1/${filename}`;
  const h = await harness({ releaseAsset: { ...asset, cdn_download_url: cdnUrl } });
  assert.equal(h.element('option[value="cloudflare"]').disabled, false);
  assert.equal(h.element('#download-alternative').href, cdnUrl);
  assert.equal(h.element('#download-alternative').listeners.click, undefined);
  assert.equal(h.element('#download-button').href, cdnUrl);
  const modified = h.click({ ctrlKey: true });
  await modified.pending;
  assert.equal(modified.event.prevented, false);
  h.useDownloader(async options => {
    assert.equal(options.autoSelect, true);
    assert.equal(options.sources[0].id, 'cloudflare');
    assert.equal(options.sources[0].url, cdnUrl);
    assert.ok(options.sources.some(candidate => candidate.id === 'blob'));
    return { blob: new Blob(['test']), filename, source: 'Cloudflare CDN' };
  });
  await h.click().pending;
  assert.deepEqual(h.saved, [{ url: 'blob:validated', filename }]);
});

test('a configured manual Cloudflare selection stays first while keeping existing fallback sources', async () => {
  const cdnUrl = `https://cdn.example.test/releases/v1.9.1/${filename}`;
  const h = await harness({ savedSource: 'cloudflare', releaseAsset: { ...asset, cdn_download_url: cdnUrl } });
  assert.equal(h.select.value, 'cloudflare');
  assert.equal(h.element('#download-alternative').href, cdnUrl);
  h.useDownloader(async options => {
    assert.equal(options.autoSelect, false);
    assert.equal(options.sources[0].id, 'cloudflare');
    assert.ok(options.sources.some(candidate => candidate.id === 'gh-proxy'));
    return { blob: new Blob(['test']), filename, source: 'Cloudflare CDN' };
  });
  await h.click().pending;
  assert.equal(h.saved.length, 1);
});

test('unconfigured or invalid CDN metadata disables Cloudflare and preserves the previous native fallback', async () => {
  for (const cdn_download_url of [undefined, 'http://cdn.example.test/releases/v1.9.1/' + filename,
    `https://cdn.example.test/releases/v1.9.0/${filename}`,
    `https://user:password@cdn.example.test/releases/v1.9.1/${filename}`,
    `https://cdn.example.test/releases/v1.9.1/${filename}?origin=untrusted`]) {
    const h = await harness({ savedSource: 'cloudflare', releaseAsset: { ...asset, cdn_download_url } });
    assert.equal(h.select.value, 'auto');
    assert.equal(h.element('option[value="cloudflare"]').disabled, true);
    assert.equal(h.element('#download-alternative').href, asset.browser_download_url);
    assert.equal(h.context.websiteDownloadSources({ ...asset, cdn_download_url })
      .some(candidate => candidate.id === 'cloudflare'), false);
  }
});
