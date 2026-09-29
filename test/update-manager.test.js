const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
  GITHUB_MIRRORS,
  UpdateManager,
  downloadToFile,
  isNewerVersion,
  normalizeVersion,
  percent,
  pickAsset
} = require('../src/main/updater/update-manager');

const fixtureHash = 'a'.repeat(64);

test('failed Linux replacement restores the original executable', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-update-rollback-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const current = path.join(dir, 'current.AppImage');
  const next = path.join(dir, 'next.AppImage');
  await fs.writeFile(current, 'old');
  await fs.writeFile(next, 'new');
  const failure = Object.assign(new Error('replacement denied'), { code: 'EACCES' });
  const manager = new UpdateManager({ platform: 'linux', env: { APPIMAGE: current }, fileSystem: {
    ...fs,
    rename: async (from, to) => {
      if (from === next) throw failure;
      return fs.rename(from, to);
    }
  } });
  await assert.rejects(manager.finalizeDownload(next), (error) => error === failure);
  assert.equal(await fs.readFile(current, 'utf8'), 'old');
  assert.equal(await fs.readFile(next, 'utf8'), 'new');
});

test('manual update checks read the current download policy', async () => {
  const { manager, calls } = fixture();
  const handlers = new Map();
  let policy = 'notify';
  manager.settingsStore = { getState: async () => ({ launcherUpdatePolicy: policy }) };
  manager.ipcMain = { handle: (name, handler) => handlers.set(name, handler) };
  manager.started = false;
  manager.start();
  await handlers.get('updater:check')();
  assert.equal(calls.download.length, 0);
  policy = 'auto';
  await handlers.get('updater:check')();
  assert.equal(calls.download.length, 1);
});
const releaseAssets = [
  { name: 'The-Melody-of-Oblivion-Remake-v9.9.9-Windows-x64.exe', browser_download_url: 'https://example.com/win-x64.exe', size: 1024 },
  { name: 'The-Melody-of-Oblivion-Remake-v9.9.9-Windows-ia32.exe', browser_download_url: 'https://example.com/win-ia32.exe', size: 1024 },
  { name: 'The-Melody-of-Oblivion-Remake-v9.9.9-Windows-arm64.exe', browser_download_url: 'https://example.com/win-arm64.exe', size: 1024 },
  { name: 'The-Melody-of-Oblivion-Remake-v9.9.9-Linux-x64.AppImage', browser_download_url: 'https://example.com/linux-x64.AppImage', size: 1024 },
  { name: 'The-Melody-of-Oblivion-Remake-v9.9.9-Linux-armv7l.AppImage', browser_download_url: 'https://example.com/linux-armv7l.AppImage', size: 1024 },
  { name: 'The-Melody-of-Oblivion-Remake-v9.9.9-macOS-arm64.zip', browser_download_url: 'https://example.com/mac-arm64.zip', size: 1024 }
].map((asset) => ({ ...asset, digest: `sha256:${fixtureHash}` }));

const githubAssets = [
  { name: 'The-Melody-of-Oblivion-Remake-v9.9.9-Windows-x64.exe', browser_download_url: 'https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/v9.9.9/The-Melody-of-Oblivion-Remake-v9.9.9-Windows-x64.exe', size: 1024 }
].map((asset) => ({ ...asset, digest: `sha256:${fixtureHash}` }));

function fixture({
  isPackaged = true,
  platform = 'win32',
  arch = 'x64',
  tag = 'v9.9.9',
  httpStatus = 200,
  downloadError = null,
  assets = releaseAssets,
  releaseBody = '## 新版本亮点\n- 修复了若干问题\n- 优化下载速度',
  downloadFile = null,
  fetchImpl = null
} = {}) {
  const calls = { download: [], spawn: [], quit: 0, relaunch: 0, showItemInFolder: [], updateAvailable: [], updateReady: [] };
  const manager = new UpdateManager({
    app: {
      isPackaged,
      getVersion: () => '1.2.0',
      getPath: () => '/tmp/downloads',
      relaunch: () => { calls.relaunch += 1; },
      quit: () => { calls.quit += 1; }
    },
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
    platform,
    arch,
    env: {},
    hashFile: async () => fixtureHash,
    shell: { showItemInFolder: (filePath) => calls.showItemInFolder.push(filePath) },
    onUpdateAvailable: (version, releaseUrl) => calls.updateAvailable.push({ version, releaseUrl }),
    onUpdateReady: (version, installAction) => calls.updateReady.push({ version, installAction }),
    fetchImpl: fetchImpl ?? (async () => ({
      ok: httpStatus >= 200 && httpStatus < 300,
      status: httpStatus,
      json: async () => ({
        tag_name: tag,
        body: releaseBody,
        html_url: 'https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/tag/v9.9.9',
        assets
      })
    })),
    downloadFile: downloadFile ?? (async (url, targetPath, onProgress) => {
      calls.download.push({ url, targetPath });
      if (downloadError) throw downloadError;
      onProgress?.(50);
      onProgress?.(100);
      return targetPath;
    }),
    fileSystem: {
      mkdir: async () => {},
      statfs: async () => ({ bavail: 1024n * 1024n * 8n, bsize: 1024n }),
      stat: async () => ({ size: 1024 }),
      chmod: async () => {},
      rename: async () => {},
      rm: async () => {}
    },
    spawnProcess: (command, args, options) => {
      calls.spawn.push({ command, args, options });
      return { unref: () => {} };
    }
  });
  manager.start();
  return { manager, calls };
}

test('更新进度被限制为整数百分比', () => {
  assert.equal(percent(54.6), 55);
  assert.equal(percent(-2), 0);
  assert.equal(percent(120), 100);
});

test('版本号比较忽略 v 前缀并按数字比较', () => {
  assert.equal(isNewerVersion('v1.3.0', '1.2.0'), true);
  assert.equal(isNewerVersion('1.2.0', 'v1.2.0'), false);
  assert.equal(isNewerVersion('1.2.9', '1.2.10'), false);
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true);
});

test('normalizeVersion 会补齐缺失的版本段', () => {
  assert.deepEqual(normalizeVersion('v1.2'), [1, 2, 0]);
  assert.deepEqual(normalizeVersion(undefined), [0, 0, 0]);
});

test('pickAsset 按平台与架构匹配 Release 附件', () => {
  assert.match(pickAsset(releaseAssets, 'win32', 'x64').name, /Windows-x64\.exe$/);
  assert.match(pickAsset(releaseAssets, 'linux', 'arm').name, /Linux-armv7l\.AppImage$/);
  assert.match(pickAsset(releaseAssets, 'darwin', 'arm64').name, /macOS-arm64\.zip$/);
  assert.equal(pickAsset([], 'win32', 'x64'), null);
});

test('开发模式明确标记为不可更新', async () => {
  const { manager } = fixture({ isPackaged: false });
  assert.equal((await manager.check()).status, 'unavailable');
});

test('检查 Release 发现新版本后自动后台下载', async () => {
  const { manager, calls } = fixture();
  const state = await manager.check();
  assert.equal(state.status, 'downloaded');
  assert.equal(state.availableVersion, '9.9.9');
  assert.equal(state.installAction, 'relaunch');
  assert.equal(state.progress, 100);
  assert.equal(calls.download.length, 1);
  assert.match(calls.download[0].url, /win-x64\.exe$/);
  assert.match(calls.download[0].targetPath, /The-Melody-of-Oblivion-Remake-v9\.9\.9-Windows-x64\.exe\.part$/);
});

test('已是最新版本时不触发下载', async () => {
  const { manager, calls } = fixture({ tag: 'v1.2.0' });
  const state = await manager.check();
  assert.equal(state.status, 'current');
  assert.equal(calls.download.length, 0);
  assert.equal(calls.updateAvailable.length, 0);
});

test('发现新版本时通知回调收到版本号与发布页链接', async () => {
  const { manager, calls } = fixture();
  await manager.check();
  assert.equal(calls.updateAvailable.length, 1);
  assert.equal(calls.updateAvailable[0].version, '9.9.9');
  assert.match(calls.updateAvailable[0].releaseUrl, /releases\/tag\/v9\.9\.9$/);
});

test('Release 接口异常时进入错误状态', async () => {
  const { manager } = fixture({ httpStatus: 500 });
  const state = await manager.check();
  assert.equal(state.status, 'error');
  assert.match(state.message, /HTTP 500/);
});

test('下载失败会报告错误', async () => {
  const { manager } = fixture({ downloadError: new Error('网络中断') });
  const state = await manager.check();
  assert.equal(state.status, 'error');
  assert.match(state.message, /网络中断/);
});

test('Windows 安装更新会启动新版本并退出', async () => {
  const { manager, calls } = fixture();
  await manager.check();
  assert.equal((await manager.install()).installing, true);
  assert.equal(calls.spawn.length, 1);
  assert.equal(calls.quit, 1);
});

test('Linux 安装更新会重启自身', async () => {
  const { manager, calls } = fixture({ platform: 'linux', arch: 'x64' });
  await manager.check();
  await manager.install();
  assert.equal(calls.relaunch, 1);
  assert.equal(calls.quit, 1);
  assert.equal(calls.spawn.length, 0);
});

test('macOS 下载完成后打开所在文件夹且不退出', async () => {
  const { manager, calls } = fixture({ platform: 'darwin', arch: 'arm64' });
  const state = await manager.check();
  assert.equal(state.installAction, 'open-folder');
  await manager.install();
  assert.equal(calls.showItemInFolder.length, 1);
  assert.equal(calls.quit, 0);
});

test('未下载完成时不允许安装', async () => {
  const { manager } = fixture();
  await assert.rejects(() => manager.install(), /尚未下载完成/);
});

test('更新下载完成后触发就绪回调', async () => {
  const { manager, calls } = fixture();
  await manager.check();
  assert.equal(calls.updateReady.length, 1);
  assert.equal(calls.updateReady[0].version, '9.9.9');
  assert.equal(calls.updateReady[0].installAction, 'relaunch');
});

test('同一版本重复检查只通知一次', async () => {
  const { manager, calls } = fixture();
  await manager.check();
  await manager.check();
  assert.equal(calls.updateAvailable.length, 1);
});

test('Release 接口直连失败时自动尝试镜像源', async () => {
  const requestedUrls = [];
  const { manager } = fixture({
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (!url.startsWith(GITHUB_MIRRORS[0])) {
        throw new Error('fetch failed');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: 'v9.9.9',
          html_url: 'https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/tag/v9.9.9',
          assets: releaseAssets
        })
      };
    }
  });
  const state = await manager.check();
  assert.equal(state.status, 'downloaded');
  assert.equal(requestedUrls[0], 'https://the-melody-of-o-r.ccwu.cc/api/latest-release');
  assert.equal(requestedUrls[1], 'https://api.github.com/repos/leiming2333/The-Melody-of-Oblivion-Remake/releases/latest');
  assert.ok(requestedUrls[2].startsWith(`${GITHUB_MIRRORS[0]}/https://api.github.com/`));
});

test('网站下载入口失败时回退 GitHub 和镜像源', async () => {
  const { manager, calls } = fixture({
    assets: githubAssets,
    downloadFile: async (url, targetPath, onProgress) => {
      calls.download.push({ url, targetPath });
      if (!url.startsWith(`${GITHUB_MIRRORS[0]}/`)) {
        throw new Error('下载更新失败（HTTP 403）');
      }
      onProgress?.(100);
      return targetPath;
    }
  });
  const state = await manager.check();
  assert.equal(state.status, 'downloaded');
  assert.match(calls.download[0].url, /^https:\/\/the-melody-of-o-r\.ccwu\.cc\/api\/download\?/);
  assert.match(calls.download[0].url, /asset=The-Melody-of-Oblivion-Remake-v9\.9\.9-Windows-x64\.exe/);
  assert.equal(calls.download[1].url, githubAssets[0].browser_download_url);
  assert.ok(calls.download.some((call) => call.url.startsWith(`${GITHUB_MIRRORS[0]}/https://github.com/`)));
});

test('所有下载源均失败时报告聚合错误', async () => {
  const { manager, calls } = fixture({
    assets: githubAssets,
    downloadFile: async (url) => {
      calls.download.push({ url });
      throw new Error('下载更新失败（HTTP 403）');
    }
  });
  const state = await manager.check();
  assert.equal(state.status, 'error');
  assert.match(state.message, /HTTP 403/);
  assert.equal(calls.download.length, GITHUB_MIRRORS.length + 3);
});

test('仅提示策略下发现新版本但不自动下载', async () => {
  const { manager, calls } = fixture();
  const state = await manager.check({ autoDownload: false });
  assert.equal(state.status, 'available');
  assert.equal(state.availableVersion, '9.9.9');
  assert.equal(calls.download.length, 0);
  assert.equal(calls.updateReady.length, 0);
  assert.equal(calls.updateAvailable.length, 1);
});

test('更新状态携带 Release 更新日志且超长内容被截断', async () => {
  const { manager } = fixture();
  const state = await manager.check({ autoDownload: false });
  assert.equal(state.releaseNotes, '## 新版本亮点\n- 修复了若干问题\n- 优化下载速度');

  const { manager: longManager } = fixture({ releaseBody: 'x'.repeat(5000) });
  const longState = await longManager.check({ autoDownload: false });
  assert.equal(longState.releaseNotes.length, 4001);
  assert.ok(longState.releaseNotes.endsWith('…'));
});

test('已是最新版本时更新日志被清空', async () => {
  const { manager } = fixture({ tag: 'v1.2.0' });
  const state = await manager.check();
  assert.equal(state.status, 'current');
  assert.equal(state.releaseNotes, null);
});

test('update selection ignores checksums and refuses another architecture', () => {
  const binary = releaseAssets[0];
  const checksum = { ...binary, name: `${binary.name}.sha256` };
  assert.equal(pickAsset([checksum, binary], 'win32', 'x64'), binary);
  assert.equal(pickAsset([binary], 'win32', 'arm64'), null);
});

test('missing or mismatched SHA-256 never makes an update installable', async () => {
  const { manager: missing } = fixture({
    assets: releaseAssets.map(({ digest: _digest, ...asset }) => asset)
  });
  assert.match((await missing.check()).message, /缺少 SHA-256/);
  await assert.rejects(missing.install(), /尚未下载完成/);

  const { manager, calls } = fixture();
  manager.hashFile = async () => 'b'.repeat(64);
  const state = await manager.check();
  assert.equal(state.status, 'error');
  assert.match(state.message, /SHA-256 不匹配/);
  assert.equal(calls.updateReady.length, 0);
  await assert.rejects(manager.install(), /尚未下载完成/);
});

test('sidecar SHA-256 is used when release metadata has no digest', async () => {
  const binary = { ...releaseAssets[0], digest: null };
  const sidecar = { name: `${binary.name}.sha256`, browser_download_url: 'https://example.com/checksum' };
  const { manager } = fixture({
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ tag_name: 'v9.9.9', assets: [sidecar, binary] }),
      text: async () => {
        assert.equal(url, sidecar.browser_download_url);
        return `${fixtureHash}  ${binary.name}\n`;
      }
    })
  });
  assert.equal((await manager.check()).status, 'downloaded');
});

test('real file verification accepts valid bytes and removes a tampered update', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-update-integrity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const expected = Buffer.from('valid update bytes');
  const binary = {
    name: 'Launcher-v9.9.9-Windows-x64.exe',
    browser_download_url: 'https://example.com/update',
    size: expected.length,
    digest: `sha256:${crypto.createHash('sha256').update(expected).digest('hex')}`
  };
  let bytes = Buffer.from('wrong update bytes');
  let ready = 0;
  const manager = new UpdateManager({
    app: { isPackaged: true, getVersion: () => '1.0.0' },
    platform: 'win32',
    arch: 'x64',
    env: { PORTABLE_EXECUTABLE_DIR: directory },
    fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v9.9.9', assets: [binary] }) }),
    downloadFile: async (_url, filePath) => fs.writeFile(filePath, bytes),
    onUpdateReady: () => { ready += 1; }
  });
  assert.equal(bytes.length, expected.length);
  assert.match((await manager.check()).message, /SHA-256 不匹配/);
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(ready, 0);

  bytes = expected;
  assert.equal((await manager.check()).status, 'downloaded');
  assert.deepEqual(await fs.readFile(manager.updateFilePath), expected);
  assert.deepEqual(await fs.readdir(directory), [binary.name]);
  assert.equal(ready, 1);
});

async function updateDownloadServer(t, handler) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-update-stream-'));
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, target: path.join(directory, 'update.part') };
}

test('an active update stream can outlast its connection timeout', async (t) => {
  const { url, target } = await updateDownloadServer(t, (_request, response) => {
    response.writeHead(200, { 'content-length': 5 });
    response.write('a');
    let count = 1;
    const timer = setInterval(() => {
      response.write('a');
      if (++count === 5) {
        clearInterval(timer);
        response.end();
      }
    }, 40);
    response.on('close', () => clearInterval(timer));
  });
  await downloadToFile(url, target, undefined, {
    enforceMinSpeed: false, connectTimeoutMs: 100, stallTimeoutMs: 1000
  });
  assert.equal(await fs.readFile(target, 'utf8'), 'aaaaa');
});

test('update downloads still abort a missing response or stalled body', async (t) => {
  const { url, target } = await updateDownloadServer(t, (request, response) => {
    if (request.url === '/stall') {
      response.writeHead(200, { 'content-length': 5 });
      response.write('a');
    }
  });
  await assert.rejects(downloadToFile(`${url}/connect`, target, undefined, {
    enforceMinSpeed: false, connectTimeoutMs: 100, stallTimeoutMs: 200
  }), { code: 'CONNECT_TIMEOUT' });
  await assert.rejects(downloadToFile(`${url}/stall`, target, undefined, {
    enforceMinSpeed: false, connectTimeoutMs: 1000, stallTimeoutMs: 100
  }), { code: 'STALL_SOURCE' });
});
