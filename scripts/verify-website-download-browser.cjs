// Offline browser acceptance. All HTTPS requests are intercepted in an isolated
// Electron session. Only synthetic installer bytes are saved, never executed.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { createDownloadAuthorizationHandler } = require('../api/download-authorization');
const { createDownloadConfigHandler } = require('../api/download-config');
const websiteCdnConfig = require('../src/shared/website-cdn-config.json');

const root = path.resolve(__dirname, '..');
const outputDirectory = path.join(os.tmpdir(), 'opencode', `website-browser-smoke-${randomUUID()}`);
const SITE = 'https://www.melodyoblivion.xyz';
const DOWNLOAD = websiteCdnConfig.baseUrl;
const CHALLENGES = 'https://challenges.cloudflare.com';
const tag = 'v1.9.3';
const bytes = Buffer.alloc(4 * 1024 * 1024 + 17, 42);
const hash = createHash('sha256').update(bytes).digest('hex');
const targets = ['Windows-x64', 'Windows-ia32', 'Windows-arm64', 'macOS-arm64', 'macOS-x64',
  'Linux-x64', 'Linux-arm64', 'Linux-armv7l'];
const assets = targets.map(target => {
  const extension = target.startsWith('Windows') ? '.exe' : target.startsWith('macOS') ? '.zip' : '.AppImage';
  const name = `The-Melody-of-Oblivion-Remake-${target}${extension}`;
  return { name, size: bytes.length, digest: `sha256:${hash}`, object_storage_verified: true,
    object_storage_download_url: `https://downloads.melodyoblivion.xyz/releases/${tag}/${name}`,
    browser_download_url: `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/${tag}/${name}` };
});
const fixtureEnv = {
  TURNSTILE_SITE_KEY: 'offline-browser-fixture-site-key',
  TURNSTILE_SECRET_KEY: 'offline-browser-fixture-turnstile-secret',
  DOWNLOAD_AUTH_SECRET: 'offline-browser-fixture-download-secret-at-least-32',
  DOWNLOAD_ALLOWED_HOSTNAMES: 'www.melodyoblivion.xyz,melodyoblivion.xyz',
  DOWNLOAD_CDN_BASE_URL: DOWNLOAD,
  DOWNLOAD_URL_TTL_SECONDS: '900'
};
const state = { mode: 'success', tokens: new Set(), requests: [], authorizations: 0,
  verifiedTokens: 0, rangeRequests: 0, activeBodies: 0, maxBodies: 0, downloadEvents: 0,
  apiResults: [], pendingBodies: new Set() };
let window;
let nextDownload;
const pageErrors = [];

// This fake widget exists only in the isolated test session, never in the site.
const widgetScript = `
  const widgets = new Map();
  let sequence = 0;
  globalThis.__fixtureTurnstile = { rendered: 0, removed: 0 };
  globalThis.turnstile = {
    render(container, options) {
      const id = String(++sequence);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.fixtureTurnstile = id;
      button.textContent = 'Offline verification fixture';
      button.style.cssText = 'width:300px;max-width:100%;min-height:65px';
      button.addEventListener('click', () => options.callback('offline-fixture-token-' + id), { once: true });
      container.append(button);
      widgets.set(id, button);
      globalThis.__fixtureTurnstile.rendered++;
      return id;
    },
    remove(id) {
      widgets.get(id)?.remove();
      widgets.delete(id);
      globalThis.__fixtureTurnstile.removed++;
    }
  };
`;

app.disableHardwareAcceleration();
app.setPath('userData', path.join(outputDirectory, 'profile'));

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function invokeApi(handler, request) {
  let status = 200;
  let result;
  const headers = new Headers();
  const response = { setHeader(name, value) { headers.set(name, value); },
    status(value) { status = value; return this; },
    json(value) { result = value; return this; } };
  const requestHeaders = Object.fromEntries(request.headers);
  // Electron's intercepted HTTPS adapter may omit Chromium's generated Origin.
  // Restore only this isolated fixture page's origin; production checks stay intact.
  if (request.method === 'POST' && !requestHeaders.origin) {
    assert.equal(new URL(window.webContents.getURL()).origin, SITE);
    requestHeaders.origin = request.initiatorOrigin || SITE;
  }
  await handler({ method: request.method, headers: requestHeaders,
    ...(request.method === 'POST' ? { body: await request.text() } : {}) }, response);
  state.apiResults.push({ pathname: new URL(request.url).pathname, status, code: result?.code ?? null });
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(result), { status, headers });
}

async function waitFor(expression, timeout = 8000) {
  try { return await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let observer;
    const timer = setTimeout(() => { observer?.disconnect(); reject(new Error('Browser condition timed out')); }, ${timeout});
    const inspect = () => {
      if (!(${expression})) return;
      clearTimeout(timer);
      observer?.disconnect();
      resolve(true);
    };
    observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
    inspect();
  })`); } catch (error) {
    const ui = await window.webContents.executeJavaScript(`({
      lang: document.documentElement.lang,
      disabled: document.querySelector('#download-button')?.disabled,
      status: document.querySelector('#download-status')?.textContent,
      progress: document.querySelector('#download-progress-text')?.textContent,
      phase: typeof downloadState === 'undefined' ? null : downloadState?.phase,
      secure: isSecureContext
    })`);
    console.error(JSON.stringify({ mode: state.mode, expression, ui, apiResults: state.apiResults,
      authorizations: state.authorizations, rangeRequests: state.rangeRequests, pageErrors }, null, 2));
    throw error;
  }
}

function click(selector) {
  return window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
}

async function beginDownload() {
  await click('#download-button');
  await waitFor("document.querySelector('[data-fixture-turnstile]') && !document.querySelector('#download-turnstile').hidden");
}

async function resetMode(mode) {
  for (const stop of [...state.pendingBodies]) stop();
  state.mode = mode;
  state.requests = [];
  state.authorizations = 0;
  state.verifiedTokens = 0;
  state.rangeRequests = 0;
  state.maxBodies = 0;
  state.tokens.clear();
  if (mode === 'disabled') await window.loadURL(`${SITE}/?offline-mode=disabled#download`);
  else await window.webContents.executeJavaScript("downloadState = null; updateDownloadLink()");
}

function fixtureOriginResponse(url, options) {
  assert.equal(new URL(url).origin, 'https://downloads.melodyoblivion.xyz');
  const range = options.headers.get('range');
  const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
  if (!match) return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
  const start = Number(match[1]);
  const end = Number(match[2]);
  state.rangeRequests++;
  const mode = state.mode;
  const data = Buffer.from(bytes.subarray(start, end + 1));
  if (mode === 'corrupt' && start === 0 && end === 1048575) data[0] ^= 255;
  const headers = { 'Content-Type': 'application/octet-stream',
    'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(data.length) };
  if (data.length <= 32768) return new Response(data, { status: 206, headers });
  let timer;
  let finished = false;
  let close;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    state.activeBodies--;
    state.pendingBodies.delete(close);
  };
  const body = new ReadableStream({
    start(controller) {
      state.activeBodies++;
      state.maxBodies = Math.max(state.maxBodies, state.activeBodies);
      close = () => { finish(); try { controller.close(); } catch {} };
      state.pendingBodies.add(close);
      timer = setTimeout(() => {
        if (finished) return;
        controller.enqueue(data.subarray(0, 32768));
        if (mode === 'cancel-transfer') return;
        timer = setTimeout(() => {
          if (finished) return;
          controller.enqueue(data.subarray(32768));
          controller.close();
          finish();
        }, 40);
      }, 20);
    },
    cancel() { finish(); }
  });
  return new Response(body, { status: 206, headers });
}

async function main() {
  await fs.mkdir(outputDirectory, { recursive: true });
  await app.whenReady();
  const { createDownloadWorker } = await import('../cloudflare/download-worker.mjs');
  const gateway = createDownloadWorker({ cache: null,
    now: () => Date.now() + (state.mode === 'expired' ? 901000 : 0),
    fetchImpl: async (url, options) => fixtureOriginResponse(url, options) });
  const authorize = createDownloadAuthorizationHandler({ env: fixtureEnv, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(options.body.get('secret'), fixtureEnv.TURNSTILE_SECRET_KEY);
    const token = options.body.get('response');
    state.verifiedTokens++;
    const valid = /^offline-fixture-token-\d+$/.test(token) && !state.tokens.has(token) && state.mode !== 'verification-failed';
    state.tokens.add(token);
    return json({ success: valid, action: 'download', hostname: 'www.melodyoblivion.xyz' });
  } });
  const webSession = session.fromPartition(`website-smoke-${randomUUID()}`);
  await webSession.protocol.handle('https', async request => {
    const url = new URL(request.url);
    // Do not log signed query strings or token bodies, even for fixtures.
    state.requests.push({ origin: url.origin, pathname: url.pathname, method: request.method });
    if (url.origin === CHALLENGES && url.pathname === '/turnstile/v0/api.js') {
      return new Response(widgetScript, { headers: { 'Content-Type': 'application/javascript' } });
    }
    if (url.origin === DOWNLOAD) return gateway.fetch(request, fixtureEnv);
    if (url.origin !== SITE) return new Response('External network disabled in offline smoke', { status: 502 });
    if (url.pathname === '/api/latest-release') return json({ tag_name: tag, assets });
    if (url.pathname === '/api/releases') return json([{ tag_name: tag, body: 'Offline acceptance fixture' }]);
    if (url.pathname === '/api/download-config') {
      return invokeApi(createDownloadConfigHandler({ env: state.mode === 'disabled' ? {} : fixtureEnv }), request);
    }
    if (url.pathname === '/api/download-authorization') {
      state.authorizations++;
      return invokeApi(authorize, request);
    }
    const files = new Map([
      ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
      ['/site.js', ['site.js', 'application/javascript']], ['/styles.css', ['styles.css', 'text/css']],
      ['/website-download-auth.mjs', ['website-download-auth.mjs', 'application/javascript']],
      ['/website-downloader.mjs', ['website-downloader.mjs', 'application/javascript']],
      ['/assets/app-icon.png', ['assets/app-icon.png', 'image/png']],
      ['/assets/backgrounds/scene-04.jpg', ['assets/backgrounds/scene-04.jpg', 'image/jpeg']]
    ]);
    const file = files.get(url.pathname);
    if (!file) return new Response('Not found in offline smoke', { status: 404 });
    return new Response(await fs.readFile(path.join(root, file[0])), { headers: { 'Content-Type': file[1] } });
  });
  webSession.on('will-download', (event, item) => {
    state.downloadEvents++;
    const pending = nextDownload;
    nextDownload = null;
    if (!pending || !assets.some(asset => asset.name === item.getFilename())) {
      event.preventDefault();
      pageErrors.push('Unexpected browser download');
      return;
    }
    const file = path.join(outputDirectory, item.getFilename());
    item.setSavePath(file);
    item.once('done', (_event, downloadState) => {
      if (downloadState === 'completed') pending.resolve(file);
      else pending.reject(new Error(`Synthetic browser download ${downloadState}`));
    });
  });
  window = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { session: webSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, backgroundThrottling: false } });
  window.webContents.on('console-message', event => {
    if (event.level === 'error') pageErrors.push(event.message);
  });
  await window.loadURL(`${SITE}/#download`);
  await waitFor("!document.querySelector('#download-button').disabled");
  assert.equal(await window.webContents.executeJavaScript('isSecureContext && Boolean(crypto.subtle)'), true);
  assert.equal(state.requests.some(request => request.origin === CHALLENGES), false);
  for (const target of targets) {
    assert.equal(await window.webContents.executeJavaScript(`
      document.querySelector('#download-platform').value = ${JSON.stringify(target)};
      document.querySelector('#download-platform').dispatchEvent(new Event('change'));
      !document.querySelector('#download-button').disabled;
    `), true);
  }
  await window.webContents.executeJavaScript("document.querySelector('#download-platform').value = 'Windows-x64'; document.querySelector('#download-platform').dispatchEvent(new Event('change'))");
  const fileSaved = new Promise((resolve, reject) => { nextDownload = { resolve, reject }; });
  await beginDownload();
  assert.equal(state.authorizations, 0);
  assert.equal(state.rangeRequests, 0);
  await window.webContents.executeJavaScript("setLanguage('en'); setLanguage('zh')");
  await click('[data-fixture-turnstile]');
  await waitFor("document.querySelector('#download-progress-text').textContent.includes('已校验')");
  const file = await fileSaved;
  const saved = await fs.readFile(file);
  assert.equal(saved.length, bytes.length);
  assert.equal(createHash('sha256').update(saved).digest('hex'), hash);
  await fs.rm(file); // Only this script's synthetic saved fixture.
  assert.equal(state.authorizations, 1);
  assert.equal(state.verifiedTokens, 1);
  assert.equal(state.rangeRequests, 6);
  assert.ok(state.maxBodies >= 4);
  assert.equal(await window.webContents.executeJavaScript('globalThis.__fixtureTurnstile.removed'), 1);
  const results = ['real browser: one verification, four concurrent ranges, correct saved size/SHA-256'];

  for (const mode of ['verification-failed', 'expired', 'corrupt', 'cancel-verification', 'cancel-transfer']) {
    await resetMode(mode);
    const before = state.downloadEvents;
    await beginDownload();
    if (mode === 'cancel-verification') await click('#download-cancel');
    else {
      await click('[data-fixture-turnstile]');
      if (mode === 'cancel-transfer') {
        await waitFor("document.querySelector('#download-progress-text').textContent.includes('正在下载') && document.querySelector('#download-progress').value > 0");
        await click('#download-cancel');
      }
    }
    const expected = mode.startsWith('cancel-') ? '已取消' : mode === 'expired' ? '过期'
      : mode === 'corrupt' ? '校验失败' : '未完成';
    await waitFor(`!document.querySelector('#download-button').disabled && document.querySelector('#download-progress-text').textContent.includes(${JSON.stringify(expected)})`);
    assert.equal(state.downloadEvents, before);
    assert.equal(state.requests.some(request => ['https://github.com', 'https://downloads.melodyoblivion.xyz'].includes(request.origin)), false);
    if (mode === 'cancel-verification') {
      assert.equal(state.authorizations, 0);
      assert.equal(state.rangeRequests, 0);
    }
    if (mode === 'verification-failed') assert.equal(state.rangeRequests, 0);
    results.push(`real browser: ${mode} saves nothing and does not bypass verification`);
  }
  await resetMode('disabled');
  await waitFor("document.querySelector('#download-status').textContent.includes('暂不可用')");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#download-button').disabled && !document.querySelector('#download-alternative').hidden"), true);
  for (const width of [1280, 360]) {
    window.setContentSize(width, 900);
    assert.equal(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'), true);
  }
  results.push('real browser: unavailable configuration keeps public alternatives and fits desktop/mobile');
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, offline: true, browser: 'Electron Chromium', results }, null, 2));
}

const deadline = setTimeout(() => {
  console.error('Offline website browser acceptance timed out');
  app.exit(1);
}, 45000);
main().then(() => {
  clearTimeout(deadline);
  window?.destroy();
  app.quit();
}).catch(error => {
  clearTimeout(deadline);
  console.error(error.stack);
  window?.destroy();
  app.exit(1);
});
