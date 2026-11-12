const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash, createHmac } = require('node:crypto');
const websiteCdnConfig = require('../src/shared/website-cdn-config.json');
const authorizationModule = import('../website-download-auth.mjs');
const downloaderModule = import('../website-downloader.mjs');

const source = fs.readFileSync(require.resolve('../site.js'), 'utf8');
const tag = 'v1.9.3';
const targets = ['Windows-x64', 'Windows-ia32', 'Windows-arm64', 'macOS-arm64', 'macOS-x64',
  'Linux-x64', 'Linux-arm64', 'Linux-armv7l'];

function releaseAsset(target, overrides = {}) {
  const extension = target.startsWith('Windows') ? '.exe' : target.startsWith('macOS') ? '.zip' : '.AppImage';
  const name = `The-Melody-of-Oblivion-Remake-${target}${extension}`;
  return { name, size: 1048576, digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${tag}/${name}`,
    object_storage_download_url: `https://downloads.melodyoblivion.xyz/releases/${tag}/${name}`,
    object_storage_verified: true, ...overrides };
}

function githubUrl(asset) {
  return `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${tag}/${asset.name}`;
}

async function harness({ release = { tag_name: tag, assets: targets.map(target => releaseAsset(target)) },
  config = { enabled: true, siteKey: 'fixture-site-key', action: 'download', baseUrl: websiteCdnConfig.baseUrl },
  fetchImpl, authorizeImpl, downloadImpl, segmentFetchImpl } = {}) {
  const { validatedDownloadBaseUrl } = await authorizationModule;
  const { downloadReleaseAsset } = await downloaderModule;
  const elements = new Map();
  const requests = [];
  const authorizations = [];
  const downloadCalls = [];
  const saved = [];
  const objectUrls = new Map();
  const timers = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const result = {
      value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, open: false, dataset: {},
      listeners: {}, attributes: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; if (['href', 'download'].includes(name)) delete this[name]; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      querySelector(selector) { return element(selector); }, querySelectorAll() { return []; },
      append() {}, replaceChildren() {}, remove() {},
      click() { if (this.href) saved.push({ url: this.href, filename: this.download, blob: objectUrls.get(this.href) }); }
    };
    elements.set(id, result);
    return result;
  }
  class BrowserURL extends URL {
    static createObjectURL(blob) {
      const value = `blob:fixture-${objectUrls.size}`;
      objectUrls.set(value, blob);
      return value;
    }
    static revokeObjectURL(value) { objectUrls.delete(value); }
  }
  const context = vm.createContext({
    document: { documentElement: { lang: 'zh-CN' }, body: element('body'), querySelector: element,
      querySelectorAll: () => [], createElement: name => element(`${name}-${elements.size}`), addEventListener() {} },
    window: { addEventListener() {} }, navigator: { platform: 'Win32', language: 'zh-CN' },
    localStorage: { getItem() {}, setItem() {} }, sessionStorage: { getItem() {}, setItem() {} },
    URL: BrowserURL, Blob, AbortController, AbortSignal,
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {}, console,
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (url === '/api/download-config') return { ok: true, json: async () => config };
      if (fetchImpl) return fetchImpl(url, options);
      if (String(url).startsWith(config?.baseUrl)) return segmentFetchImpl(url, options);
      return { ok: true, json: async () => release };
    }
  });
  vm.runInContext(source, context);
  context.loadWebsiteAuthorization = async () => ({ validatedDownloadBaseUrl,
    async authorizeWebsiteDownload(options) {
      authorizations.push(options);
      if (authorizeImpl) return authorizeImpl(options);
      const expires = Math.floor(Date.now() / 1000) + 900;
      const path = new URL(options.expectedUrl).pathname;
      const signature = createHmac('sha256', 'fixture-download-signing-key-at-least-32')
        .update(`download-v1\n${path}\n${expires}`).digest('base64url');
      return { url: `${options.expectedUrl}?expires=${expires}&signature=${signature}`,
        expiresAt: new Date(expires * 1000).toISOString() };
    }
  });
  context.loadWebsiteDownloader = async () => ({ async downloadReleaseAsset(options) {
    downloadCalls.push(options);
    if (downloadImpl) return downloadImpl(options);
    if (segmentFetchImpl) return downloadReleaseAsset(options);
    return new Promise(() => {});
  } });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  const select = target => {
    element('#download-platform').value = target;
    element('#download-platform').listeners.change();
  };
  const click = () => {
    const button = element('#download-button');
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    const pending = button.listeners.click?.(event);
    return { ...event, pending };
  };
  const cancel = () => element('#download-cancel').listeners.click();
  return { context, element, requests, authorizations, downloadCalls, saved, timers, objectUrls, select, click, cancel };
}

test('all eight verified R2 targets require the gate and never expose a direct href', async () => {
  const h = await harness();
  for (const target of targets) {
    const asset = releaseAsset(target);
    h.select(target);
    const button = h.element('#download-button');
    assert.equal(button.href, undefined);
    assert.equal(button.download, undefined);
    assert.equal(button.disabled, false);
    assert.equal(button.attributes['aria-disabled'], 'false');
    assert.match(h.element('#download-status').textContent, /对象存储/);
    assert.equal(h.element('#download-alternative').href, githubUrl(asset));
    assert.equal(h.element('#download-alternative').hidden, false);
    assert.equal(h.element('#download-turnstile').hidden, true);
  }
  const button = h.element('#download-button');
  assert.equal(h.click().prevented, true);
  assert.equal(h.element('#download-turnstile').hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(button.attributes['aria-disabled'], 'true');
  assert.deepEqual(h.requests.map(request => request.url), [
    '/api/latest-release', '/api/download-config'
  ]);
  h.cancel();
  await new Promise(setImmediate);
  assert.equal(h.element('#download-button').disabled, false);
});

test('missing or disabled download configuration keeps the verified download button unavailable', async () => {
  const h = await harness({ config: { enabled: false, siteKey: null, action: 'download' } });
  const button = h.element('#download-button');
  assert.equal(button.disabled, true);
  assert.equal(button.attributes['aria-disabled'], 'true');
  assert.equal(button.href, undefined);
  assert.match(button.querySelector('#download-button-label').textContent, /暂不可用/);
  assert.equal(h.element('#download-turnstile').hidden, true);
  assert.equal(h.click().prevented, true);
  assert.equal(h.element('#download-turnstile').hidden, true);
});

test('unverified R2 metadata never becomes the primary protected target', async () => {
  const asset = releaseAsset('Windows-x64', { object_storage_verified: false });
  const h = await harness({ release: { tag_name: tag, assets: [asset] } });
  const button = h.element('#download-button');
  assert.equal(button.href, undefined);
  assert.equal(button.disabled, false);
  assert.equal(h.element('#download-alternative').hidden, false);
  assert.match(h.element('#download-status').textContent, /GitHub/);
  assert.equal(h.click().prevented, true);
  assert.equal(h.element('#download-turnstile').hidden, false);
  h.cancel();
  await new Promise(setImmediate);
});

test('malformed release metadata never activates the Turnstile download button', async () => {
  for (const release of [
    null,
    { tag_name: tag, assets: {} },
    { tag_name: tag, assets: [], draft: true },
    { tag_name: tag, assets: [], prerelease: true }
  ]) {
    const h = await harness({ release });
    const button = h.element('#download-button');
    assert.equal(button.disabled, true);
    assert.equal(button.href, undefined);
    assert.equal(h.element('#download-alternative').hidden, true);
  }
});

test('download HTML includes the verification gate and does not publish a direct R2 href', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /<button[^>]*id="download-button"[^>]*disabled/);
  assert.match(html, /id="download-turnstile"[^>]*aria-label="Cloudflare 真人验证"/);
  assert.match(html, /data-i18n="download.verification"/);
  assert.match(html, /验证并下载/);
  assert.match(html, /id="download-progress"/);
  assert.match(html, /id="download-cancel"/);
  assert.match(html, /1 MiB 分块、4 路并发/);
  assert.doesNotMatch(html, /id="download-button"[^>]*href=/);
  for (const target of targets) assert.ok(html.includes(`value="${target}"`));
  for (const url of [
    'https://pan.baidu.com/s/1Vl9HrV07wQXbHRvHnyqC0A?pwd=2333',
    'https://pan.baidu.com/s/1FXccyrw0VI93lefYu2i2nQ?pwd=2333',
    'https://pan.baidu.com/s/1ic0OzXT28sITeLHuE-FG-w?pwd=2333',
    'https://pan.baidu.com/s/1346_XbYBw1fyeFT7h4pavg?pwd=2333',
    'https://pan.baidu.com/s/18IMi-o8Hi7o_5Qq5kt_IpA?pwd=2333',
    'https://pan.baidu.com/s/1Io_mueE1z1RHGWr9g3VJDg?pwd=2333',
    'https://pan.baidu.com/s/1tghBkgFUBBC_6kK8hcA3LA?pwd=2333',
    'https://pan.baidu.com/s/1U2XLcC79bmWB3lsAarlkXg?pwd=2333'
  ]) assert.ok(html.includes(url));
  assert.ok(html.includes('https://wwayi.lanzoum.com/iE8J84fp5euj'));
  assert.ok(html.includes('https://wwayi.lanzoum.com/iMm454fp4uhg'));
  assert.ok(html.includes('<code>dywd</code>'));
  assert.ok(html.includes('<code>gpqs</code>'));
});

test('a verified click completes real parallel Range reads and saves only the checked Blob', async () => {
  const bytes = Buffer.alloc(1048576 * 4 + 17, 42);
  const asset = releaseAsset('Windows-x64', { size: bytes.length,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  const ranges = [];
  let releaseFirst;
  let firstReleased = false;
  let parallel = false;
  const h = await harness({ release: { tag_name: tag, assets: [asset] },
    segmentFetchImpl: async (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, websiteCdnConfig.baseUrl);
      assert.equal(parsed.pathname, `/releases/${tag}/${asset.name}`);
      assert.equal(parsed.searchParams.getAll('signature').length, 1);
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.redirect, 'error');
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range).map(Number);
      ranges.push([start, end]);
      let body = bytes.subarray(start, end + 1);
      if (start === 0 && end === 1048575) {
        body = new ReadableStream({ start(controller) { releaseFirst = () => {
          firstReleased = true;
          controller.enqueue(bytes.subarray(start, end + 1));
          controller.close();
        }; } });
      }
      if (start === 1048576) { parallel = !firstReleased; releaseFirst(); }
      return new Response(body, { status: 206, headers: {
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1)
      } });
    } });
  const click = h.click();
  assert.equal(click.prevented, true);
  assert.equal(h.element('#download-platform').disabled, true);
  await click.pending;
  assert.equal(parallel, true);
  assert.equal(h.authorizations.length, 1);
  assert.equal(h.downloadCalls.length, 1);
  assert.equal(h.downloadCalls[0].concurrency, 4);
  assert.equal(h.downloadCalls[0].segmentBytes, 1048576);
  assert.equal(h.downloadCalls[0].sources.length, 1);
  assert.equal(ranges.length, 6); // One probe and five parts.
  assert.equal(h.saved.length, 1);
  assert.ok(h.saved[0].url.startsWith('blob:'));
  assert.equal(h.saved[0].filename, asset.name);
  assert.deepEqual(Buffer.from(await h.saved[0].blob.arrayBuffer()), bytes);
  assert.equal(h.element('#download-platform').disabled, false);
  assert.equal(h.element('#download-button').disabled, false);
  assert.equal(h.element('#download-cancel').hidden, true);
  assert.equal(h.element('#download-turnstile').hidden, true);
  assert.equal(h.element('#download-progress').value, 100);
  assert.match(h.element('#download-progress-text').textContent, /已校验/);
  h.timers.find(timer => timer.delay === 60000).callback();
  assert.equal(h.objectUrls.size, 0);
});

test('missing or unsafe size/digest disables segmented downloads but retains GitHub alternatives', async () => {
  for (const changes of [{ size: 0 }, { size: '1048576' }, { size: Number.MAX_SAFE_INTEGER + 1 },
    { digest: null }, { digest: `sha256:${'x'.repeat(64)}` }]) {
    const asset = releaseAsset('Windows-x64', changes);
    const h = await harness({ release: { tag_name: tag, assets: [asset] } });
    assert.equal(h.element('#download-button').disabled, true);
    assert.equal(h.element('#download-alternative').href, githubUrl(asset));
    assert.equal(h.element('#download-alternative').hidden, false);
    await h.click().pending;
    assert.equal(h.authorizations.length, 0);
    assert.equal(h.saved.length, 0);
  }
});

test('tampered R2 source metadata never becomes an object-storage source or a direct button href', async () => {
  const valid = releaseAsset('Windows-x64');
  for (const changes of [
    { object_storage_verified: false }, { object_storage_verified: 'true' }, { object_storage_verified: undefined },
    { object_storage_download_url: valid.object_storage_download_url.replace(tag, 'v1.9.2') },
    { object_storage_download_url: `${valid.object_storage_download_url}?expires=1` },
    { object_storage_download_url: `${valid.object_storage_download_url}#hash` },
    { object_storage_download_url: valid.object_storage_download_url.replace('downloads.melodyoblivion.xyz', 'evil.example') },
    { object_storage_download_url: valid.object_storage_download_url.replace('https:', 'http:') },
    { object_storage_download_url: valid.object_storage_download_url.replace(valid.name, 'other.exe') }
  ]) {
    const asset = releaseAsset('Windows-x64', changes);
    const h = await harness({ release: { tag_name: tag, assets: [asset] } });
    assert.equal(h.element('#download-button').href, undefined);
    assert.match(h.element('#download-status').textContent, /GitHub/);
    assert.doesNotMatch(h.element('#download-status').textContent, /对象存储/);
    assert.equal(h.element('#download-alternative').href, githubUrl(asset));
  }
});

test('unknown configuration bases never enable downloads, including the public R2 origin', async () => {
  for (const baseUrl of [undefined, 'https://downloads.melodyoblivion.xyz', 'https://evil.example',
    'https://verified-downloads.melodyoblivion.xyz.evil.example']) {
    const h = await harness({ config: { enabled: true, siteKey: 'fixture', action: 'download', baseUrl } });
    assert.equal(h.element('#download-button').disabled, true);
    assert.equal(h.element('#download-alternative').hidden, false);
    await h.click().pending;
    assert.equal(h.authorizations.length, 0);
  }
});

test('both permitted website path gateways work without changing public download alternatives', async () => {
  const asset = releaseAsset('Windows-x64');
  for (const baseUrl of websiteCdnConfig.allowedBases.filter(base => base.includes('/verified-downloads'))) {
    const h = await harness({ config: { enabled: true, siteKey: 'fixture', action: 'download', baseUrl },
      downloadImpl: async options => ({ blob: new Blob([Buffer.alloc(options.asset.size)]),
        filename: options.asset.name, source: 'Cloudflare CDN' }) });
    assert.equal(h.element('#download-button').disabled, false);
    await h.click().pending;
    assert.equal(h.authorizations[0].expectedUrl, `${baseUrl}/releases/${tag}/${asset.name}`);
    assert.ok(h.downloadCalls[0].sources[0].url.startsWith(`${baseUrl}/releases/`));
    assert.equal(h.element('#download-alternative').href, githubUrl(asset));
    assert.equal(h.saved.length, 1);
  }
});

test('cancel and repeated clicks never start another request or save a late result', async () => {
  let completeDownload;
  const asset = releaseAsset('Windows-x64');
  const h = await harness({ downloadImpl: options => {
    options.onProgress({ phase: 'downloading', loaded: 12345, total: asset.size, source: 'Cloudflare CDN' });
    return new Promise(resolve => { completeDownload = resolve; });
  } });
  const first = h.click();
  await new Promise(setImmediate);
  assert.equal(h.element('#download-turnstile').hidden, true);
  assert.equal(h.element('#download-platform').disabled, true);
  assert.equal(h.element('#download-cancel').hidden, false);
  await h.click().pending;
  assert.equal(h.authorizations.length, 1);
  assert.equal(h.downloadCalls.length, 1);
  h.context.setLanguage('en');
  assert.match(h.element('#download-progress-text').textContent, /Downloading/);
  h.cancel();
  await first.pending;
  completeDownload({ blob: new Blob([Buffer.alloc(asset.size)]), filename: asset.name, source: 'Cloudflare CDN' });
  await new Promise(setImmediate);
  assert.equal(h.saved.length, 0);
  assert.match(h.element('#download-progress-text').textContent, /cancelled/);
  assert.equal(h.element('#download-button').disabled, false);
  assert.equal(h.element('#download-platform').disabled, false);
});

test('failed verification, expired permits, and corrupt bytes never save files or auto-follow public links', async () => {
  for (const code of ['VERIFICATION_FAILED', 'VERIFICATION_EXPIRED', 'AUTHORIZATION_EXPIRED',
    'CHECKSUM_MISMATCH', 'SIZE_MISMATCH']) {
    const verifying = code.startsWith('VERIFICATION');
    const fail = async () => { throw Object.assign(new Error('fixture failure'), { code }); };
    const h = await harness({ ...(verifying ? { authorizeImpl: fail } : { downloadImpl: fail }) });
    await h.click().pending;
    assert.equal(h.saved.length, 0);
    assert.equal(h.element('#download-alternative').hidden, false);
    assert.equal(h.element('#download-button').disabled, false);
    assert.match(h.element('#download-progress-text').textContent,
      code.includes('EXPIRED') ? /过期/ : code.endsWith('MISMATCH') ? /校验失败/ : /未完成/);
    assert.equal(h.requests.filter(request => request.url.startsWith('https://')).length, 0);
  }
});

test('a wrong result filename or Blob length cannot be saved even if a downloader resolves', async () => {
  const asset = releaseAsset('Windows-x64');
  for (const result of [
    { blob: new Blob(['short']), filename: asset.name },
    { blob: new Blob([Buffer.alloc(asset.size)]), filename: 'other.exe' },
    { blob: null, filename: asset.name }
  ]) {
    const h = await harness({ downloadImpl: async () => result });
    await h.click().pending;
    assert.equal(h.saved.length, 0);
    assert.match(h.element('#download-progress-text').textContent, /未保存/);
  }
});
