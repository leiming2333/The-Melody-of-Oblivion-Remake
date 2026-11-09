const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../site.js'), 'utf8');
const tag = 'v1.9.2';
const targets = ['Windows-x64', 'Windows-ia32', 'Windows-arm64', 'macOS-arm64', 'macOS-x64',
  'Linux-x64', 'Linux-arm64', 'Linux-armv7l'];

function releaseAsset(target, overrides = {}) {
  const extension = target.startsWith('Windows') ? '.exe' : target.startsWith('macOS') ? '.zip' : '.AppImage';
  const name = `The-Melody-of-Oblivion-Remake-${target}${extension}`;
  return { name, size: 1048576, digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: `https://fixture.public.blob.vercel-storage.com/releases/${tag}/${name}`,
    object_storage_download_url: `https://downloads.melodyoblivion.xyz/releases/${tag}/${name}`,
    object_storage_verified: true,
    ...overrides };
}
function githubUrl(asset) {
  return `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${tag}/${asset.name}`;
}

async function harness({ release = { tag_name: tag, assets: targets.map(target => releaseAsset(target)) },
  fetchImpl } = {}) {
  const elements = new Map(), requests = [], nativeDownloads = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const result = {
      value: '', textContent: '', innerHTML: '', hidden: false, open: false, dataset: {},
      listeners: {}, attributes: {}, classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; if (['href', 'download'].includes(name)) delete this[name]; },
      addEventListener(name, handler) { this.listeners[name] = handler; },
      querySelector: element, querySelectorAll() { return []; },
      append() {}, replaceChildren() {}
    };
    elements.set(id, result);
    return result;
  }
  const context = vm.createContext({
    document: { documentElement: { lang: 'zh-CN' }, body: element('body'), querySelector: element,
      querySelectorAll: () => [], createElement: name => element(`${name}-${elements.size}`), addEventListener() {} },
    window: { addEventListener() {} }, navigator: { platform: 'Win32', language: 'zh-CN' },
    localStorage: { getItem() {}, setItem() {} }, sessionStorage: { getItem() {}, setItem() {} }, URL,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchImpl ? fetchImpl(url, options) : { ok: true, json: async () => release };
    }
  });
  vm.runInContext(source, context);
  await new Promise(setImmediate);
  const select = target => {
    element('#download-platform').value = target;
    element('#download-platform').listeners.change();
  };
  const click = () => {
    const link = element('#download-button');
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    link.listeners.click?.(event);
    if (!event.prevented && link.href) nativeDownloads.push({ url: link.href, filename: link.download });
    return event;
  };
  return { context, element, requests, nativeDownloads, select, click };
}

test('all eight platforms use verified object storage links and browser native downloads', async () => {
  const h = await harness();
  for (const target of targets) {
    const asset = releaseAsset(target);
    h.select(target);
    const link = h.element('#download-button');
    assert.equal(link.href, asset.object_storage_download_url);
    assert.equal(link.download, asset.name);
    assert.equal(link.attributes['aria-disabled'], 'false');
    assert.equal(link.attributes.tabindex, undefined);
    assert.match(h.element('#download-status').textContent, /对象存储/);
    assert.equal(h.element('#download-alternative').href, githubUrl(asset));
    assert.equal(h.element('#download-alternative').hidden, false);
    assert.equal(h.click().prevented, false);
    assert.deepEqual(h.nativeDownloads.at(-1), { url: asset.object_storage_download_url, filename: asset.name });
  }
  assert.deepEqual(h.requests.map(request => request.url), ['/api/latest-release']);
});

test('unsynced object storage honestly uses the matching GitHub asset', async () => {
  const asset = releaseAsset('Windows-x64');
  asset.browser_download_url = githubUrl(asset);
  delete asset.object_storage_download_url;
  delete asset.object_storage_verified;
  asset.cdn_download_url = `https://downloads.melodyoblivion.xyz/releases/${tag}/${asset.name}`;
  const h = await harness({ release: { tag_name: tag, assets: [asset] } });
  assert.equal(h.element('#download-button').href, githubUrl(asset));
  assert.equal(h.element('#download-button-label').textContent, '从 GitHub 下载');
  assert.match(h.element('#download-status').textContent, /GitHub.*对象存储尚未就绪/);
  assert.equal(h.element('#download-alternative').hidden, true);
  assert.equal(h.click().prevented, false);
  assert.deepEqual(h.requests.map(request => request.url), ['/api/latest-release']);
});

test('unverified sizes, digests, and object storage origins never become primary object links', async () => {
  for (const changes of [
    { digest: null }, { digest: `sha256:${'x'.repeat(64)}` }, { size: 0 }, { size: Number.MAX_SAFE_INTEGER + 1 },
    { size: '1048576' }, { browser_download_url: 'https://evil.example/update.exe' },
    { browser_download_url: 'http://fixture.public.blob.vercel-storage.com/update.exe' },
    { browser_download_url: 'https://fixture.public.blob.vercel-storage.com.evil.example/update.exe' },
    { browser_download_url: 'https://user:secret@fixture.public.blob.vercel-storage.com/update.exe' },
    { browser_download_url: 'https://fixture.public.blob.vercel-storage.com:8443/update.exe' }
  ]) {
    const asset = releaseAsset('Windows-x64', { object_storage_verified: false, ...changes });
    const h = await harness({ release: { tag_name: tag, assets: [asset] } });
    assert.equal(h.element('#download-button').href, githubUrl(asset));
    assert.match(h.element('#download-status').textContent, /GitHub.*对象存储尚未就绪/);
    assert.doesNotMatch(h.element('#download-status').textContent, /Vercel Blob|NaN/);
  }
});

test('R2 metadata requires the server verification marker and exact release path', async () => {
  const valid = releaseAsset('Windows-x64');
  for (const changes of [
    { object_storage_verified: false }, { object_storage_verified: 'true' }, { object_storage_verified: undefined },
    { object_storage_verified: true, object_storage_download_url: valid.object_storage_download_url.replace(tag, 'v1.9.1') },
    { object_storage_verified: true, object_storage_download_url: `${valid.object_storage_download_url}?expires=1` },
    { object_storage_verified: true, object_storage_download_url: `${valid.object_storage_download_url}#part` },
    { object_storage_verified: true, object_storage_download_url: valid.object_storage_download_url.replace(valid.name, 'other.exe') },
    { object_storage_verified: true, object_storage_download_url: valid.object_storage_download_url.replace('downloads.melodyoblivion.xyz', 'evil.example') },
    { object_storage_verified: true, object_storage_download_url: `https://user:secret@downloads.melodyoblivion.xyz/releases/${tag}/${valid.name}` },
    { object_storage_verified: true, object_storage_download_url: valid.object_storage_download_url.replace('https:', 'http:') },
    { object_storage_verified: true, object_storage_download_url: valid.object_storage_download_url.replace('downloads.melodyoblivion.xyz', 'downloads.melodyoblivion.xyz:443') },
    { object_storage_verified: true, object_storage_download_url: valid.object_storage_download_url.replace('https://', 'https://other.example@') }
  ]) {
    const asset = releaseAsset('Windows-x64', { ...changes, browser_download_url: githubUrl(valid) });
    const h = await harness({ release: { tag_name: tag, assets: [asset] } });
    assert.equal(h.element('#download-button').href, githubUrl(asset));
    assert.equal(h.element('#download-alternative').hidden, true);
    assert.match(h.element('#download-status').textContent, /GitHub.*对象存储尚未就绪/);
  }
});

test('public Blob metadata remains a native fallback when R2 is not ready', async () => {
  const asset = releaseAsset('Windows-x64', { object_storage_verified: false });
  const h = await harness({ release: { tag_name: tag, assets: [asset] } });
  assert.equal(h.element('#download-button').href, asset.browser_download_url);
  assert.match(h.element('#download-status').textContent, /对象存储/);
  assert.doesNotMatch(h.element('#download-status').textContent, /Vercel|Blob|Cloudflare|R2/);
  assert.equal(h.element('#download-alternative').href, githubUrl(asset));
});

test('platform and language changes preserve the real native source', async () => {
  const windows = releaseAsset('Windows-x64');
  const linux = releaseAsset('Linux-arm64');
  linux.browser_download_url = githubUrl(linux);
  linux.object_storage_verified = false;
  const h = await harness({ release: { tag_name: tag, assets: [windows, linux] } });
  h.context.setLanguage('en');
  assert.equal(h.element('#download-button-label').textContent, 'Download launcher');
  assert.match(h.element('#download-status').textContent, /Object storage/);
  assert.doesNotMatch(h.element('#download-status').textContent, /Vercel|Blob|Cloudflare|R2/);
  assert.equal(h.element('#download-button').href, windows.object_storage_download_url);
  h.select('Linux-arm64');
  assert.equal(h.element('#download-button-label').textContent, 'Download from GitHub');
  assert.match(h.element('#download-status').textContent, /GitHub.*Object storage is not ready/);
  h.context.setLanguage('zh');
  assert.equal(h.element('#download-platform').value, 'Linux-arm64');
  assert.equal(h.element('#download-button').href, githubUrl(linux));
  assert.match(h.element('#download-status').textContent, /对象存储尚未就绪/);
});

test('a platform without a release asset has no active download link', async () => {
  const asset = releaseAsset('Windows-x64');
  const h = await harness({ release: { tag_name: tag, assets: [asset] } });
  assert.equal(h.element('#download-button').href, asset.object_storage_download_url);
  h.select('Linux-x64');
  assert.equal(h.element('#download-button').href, undefined);
  assert.equal(h.element('#download-button').attributes['aria-disabled'], 'true');
  assert.equal(h.element('#download-button').attributes.tabindex, '-1');
  assert.match(h.element('#download-status').textContent, /暂无该平台/);
  h.click();
  assert.deepEqual(h.nativeDownloads, []);
  h.select('Windows-x64');
  assert.equal(h.element('#download-button').href, asset.object_storage_download_url);
});

test('failed or malformed latest metadata leaves downloads unavailable with public alternatives', async () => {
  const failures = [
    async () => { throw new Error('network unavailable'); },
    async () => ({ ok: false }),
    ...[null, { tag_name: tag, assets: {} }, { tag_name: tag, assets: [], draft: true },
      { tag_name: tag, assets: [], prerelease: true }].map(release => async () => ({ ok: true, json: async () => release }))
  ];
  for (const fetchImpl of failures) {
    const h = await harness({ fetchImpl });
    assert.equal(h.element('#download-button').href, undefined);
    assert.equal(h.element('#download-alternative').hidden, true);
    assert.match(h.element('#download-status').textContent, /GitHub Releases.*网盘/);
  }
});

test('download HTML provides native links, eight targets, and existing public alternatives', () => {
  const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
  assert.match(html, /<a[^>]*id="download-button"[^>]*aria-disabled="true"/);
  assert.match(html, /id="download-alternative"/);
  assert.match(html, /<noscript>.*github\.com.*releases\/latest/);
  for (const target of targets) assert.ok(html.includes(`value="${target}"`));
  assert.ok(html.includes('https://pan.baidu.com/s/1H_Glo2r43eftFvzdItooWA?pwd=2333'));
  assert.ok(html.includes('https://wwayi.lanzoum.com/b01gicolti'));
  assert.doesNotMatch(html, /download-turnstile|download-progress|download-cancel|真人验证|验证并下载/);
});
