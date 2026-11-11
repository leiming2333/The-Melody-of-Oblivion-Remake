const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { UpdateManager } = require('../src/main/updater/update-manager');

const targetName = 'The-Melody-of-Oblivion-Remake-Windows-x64.exe';
const patchName = 'patch-v1.9.3-to-v1.9.4-windows-x64.patch';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function i64(value) {
  const bytes = Buffer.alloc(8);
  let number = BigInt(value);
  for (let index = 0; index < 7; index += 1) {
    bytes[index] = Number(number & 0xffn);
    number >>= 8n;
  }
  bytes[7] |= Number(number & 0x7fn);
  return bytes;
}

function extraPatch(oldBytes, newBytes) {
  const control = Buffer.concat([i64(0), i64(newBytes.length), i64(0)]);
  const compressed = [control, Buffer.alloc(0), newBytes].map(value => zlib.zstdCompressSync(value));
  return Buffer.concat([Buffer.from('TRDIFF10'), i64(compressed[0].length), i64(compressed[1].length),
    i64(newBytes.length), ...compressed]);
}

function response(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => typeof value === 'string' ? value : JSON.stringify(value)
  };
}

async function fixture(t, { patch = true, corruptPatch = false, currentFile = null } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-update-delta-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseBytes = Buffer.from(`old-${'x'.repeat(2048)}`);
  const oldBytes = currentFile ?? baseBytes;
  const newBytes = Buffer.from(`new-${'y'.repeat(2048)}`);
  const oldPath = path.join(root, 'current', targetName);
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, oldBytes);
  const patchBytes = extraPatch(baseBytes, newBytes);
  const manifest = {
    schemaVersion: 1, from: 'v1.9.3', to: 'v1.9.4',
    patches: [{
      target: 'windows-x64', asset: targetName, fromSha256: sha256(baseBytes),
      toSha256: sha256(newBytes), toSize: newBytes.length, name: patchName,
      size: patchBytes.length, sha256: sha256(patchBytes)
    }]
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const release = {
    tag_name: 'v1.9.4', body: '', html_url: 'https://example.test/v1.9.4',
    assets: [
      { name: targetName, browser_download_url: 'https://example.test/full.exe',
        size: newBytes.length, digest: `sha256:${sha256(newBytes)}` },
      ...(patch ? [
        { name: 'patch-manifest.json', browser_download_url: 'https://example.test/patch-manifest.json',
          size: Buffer.byteLength(manifestText), digest: `sha256:${sha256(manifestText)}` },
        { name: patchName,
          browser_download_url: `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/v1.9.4/${patchName}`,
          size: patchBytes.length, digest: `sha256:${sha256(patchBytes)}` }
      ] : [])
    ]
  };
  const calls = { downloads: [], quit: 0, relaunch: 0, ready: [] };
  const manager = new UpdateManager({
    app: {
      isPackaged: true, getVersion: () => '1.9.3',
      getPath: (name) => path.join(root, name), relaunch: () => { calls.relaunch += 1; },
      quit: () => { calls.quit += 1; }
    },
    BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: () => {} },
    platform: 'win32', arch: 'x64',
    env: { PORTABLE_EXECUTABLE_DIR: path.dirname(oldPath), PORTABLE_EXECUTABLE_FILE: oldPath },
    hashFile: async (file) => sha256(await fs.readFile(file)),
    onUpdateReady: (version, action) => calls.ready.push({ version, action }),
    fetchImpl: async (url) => {
      if (url.includes('patch-manifest.json')) return response(manifestText);
      if (url.includes('/api/latest-release') || url.includes('/releases/latest')
        || url.includes('github.com/leiming2333')) return response(release);
      if (url.includes('patch')) return response(corruptPatch ? 'corrupt patch' : patchBytes);
      return response('not found', 404);
    },
    downloadFile: async (url, filePath, onProgress) => {
      calls.downloads.push(url);
      onProgress?.(50);
      const bytes = url.includes('patch') && !corruptPatch ? patchBytes : newBytes;
      await fs.writeFile(filePath, bytes);
      onProgress?.(100);
      return filePath;
    },
    fileSystem: fs
  });
  return { root, oldBytes, newBytes, oldPath, manifest, patchBytes, release, calls, manager };
}

test('prefers a verified delta patch and hands the exact target to the existing transaction', async t => {
  const f = await fixture(t);
  const state = await f.manager.check();
  assert.equal(state.status, 'downloaded');
  assert.equal(state.message.includes('增量更新'), true);
  assert.deepEqual(f.calls.downloads, [
    `https://downloads.melodyoblivion.xyz/patches/v1.9.4/${patchName}`
  ]);
  assert.deepEqual(await fs.readFile(f.manager.updateFilePath), f.newBytes);
  assert.equal(f.manager.transaction.sha256, sha256(f.newBytes));
  assert.equal(f.manager.transaction.fromVersion, '1.9.3');
  assert.equal(f.manager.transaction.toVersion, '1.9.4');
  assert.deepEqual(f.calls.ready, [{ version: '1.9.4', action: 'relaunch' }]);
  assert.equal((await fs.readdir(path.dirname(f.manager.updateFilePath))).some(name => name.endsWith('.patch')), false);
});

test('falls back from a missing R2 patch mirror to GitHub without using the full package', async t => {
  const f = await fixture(t);
  f.manager.fetchImpl = async (url) => {
    if (url.startsWith('https://downloads.melodyoblivion.xyz/patches/')) return response('missing', 404);
    if (url.includes('patch-manifest.json')) return response(`${JSON.stringify(f.manifest, null, 2)}\n`);
    return response(f.release);
  };
  f.manager.downloadFile = async (url, filePath, onProgress) => {
    f.calls.downloads.push(url);
    if (url.startsWith('https://downloads.melodyoblivion.xyz/patches/')) {
      throw Object.assign(new Error('mirror missing'), { code: 'HTTP_ERROR' });
    }
    await fs.writeFile(filePath, f.patchBytes);
    onProgress?.(100);
    return filePath;
  };
  const state = await f.manager.check();
  assert.equal(state.status, 'downloaded');
  assert.match(f.calls.downloads[0], /^https:\/\/downloads\.melodyoblivion\.xyz\/patches\//);
  assert.ok(f.calls.downloads.length >= 2);
  assert.ok(f.calls.downloads.every(url => !url.includes('/full.exe')));
  assert.deepEqual(await fs.readFile(f.manager.updateFilePath), f.newBytes);
});

test('falls back to the full package when the installed file is not the patch base', async t => {
  const f = await fixture(t, { currentFile: Buffer.from('modified local executable') });
  const state = await f.manager.check();
  assert.equal(state.status, 'downloaded');
  assert.match(f.calls.downloads.at(-1), /full\.exe$/);
  assert.deepEqual(await fs.readFile(f.manager.updateFilePath), f.newBytes);
});

test('falls back to the full package when the patch bytes are corrupt or the manifest is absent', async t => {
  const corrupted = await fixture(t, { corruptPatch: true });
  assert.equal((await corrupted.manager.check()).status, 'downloaded');
  assert.match(corrupted.calls.downloads.at(-1), /full\.exe$/);
  assert.deepEqual(await fs.readFile(corrupted.manager.updateFilePath), corrupted.newBytes);

  const absent = await fixture(t, { patch: false });
  assert.equal((await absent.manager.check()).status, 'downloaded');
  assert.match(absent.calls.downloads.at(-1), /full\.exe$/);
  assert.deepEqual(await fs.readFile(absent.manager.updateFilePath), absent.newBytes);
});

test('macOS retains one verified zip base and removes older cached versions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-macos-base-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zip = Buffer.from('verified official macOS zip');
  const asset = { name: 'The-Melody-of-Oblivion-Remake-macOS-arm64.zip', size: zip.length };
  const source = path.join(root, 'downloaded.zip');
  await fs.writeFile(source, zip);
  const oldDirectory = path.join(root, 'userData', 'update-base', '1.9.3');
  await fs.mkdir(oldDirectory, { recursive: true });
  await fs.writeFile(path.join(oldDirectory, 'old.zip'), 'old');
  const manager = new UpdateManager({
    app: { getPath: name => name === 'userData' ? path.join(root, 'userData') : path.join(root, name), isPackaged: true },
    platform: 'darwin', arch: 'arm64', fileSystem: fs,
    hashFile: async file => sha256(await fs.readFile(file))
  });
  await manager.preserveMacPatchBase(asset, 'v1.9.4', source, sha256(zip));
  const loaded = await manager.loadMacPatchBase(asset, '1.9.4');
  assert.equal(loaded.sha256, sha256(zip));
  assert.deepEqual(await fs.readFile(loaded.path), zip);
  await assert.rejects(fs.stat(oldDirectory), { code: 'ENOENT' });
  await fs.writeFile(loaded.path, 'tampered');
  assert.equal(await manager.loadMacPatchBase(asset, '1.9.4'), null);
});

test('cancelling a delta download returns to available without starting a full download', async t => {
  const f = await fixture(t);
  let started;
  const urls = [];
  const waiting = new Promise(resolve => { started = resolve; });
  f.manager.downloadFile = (url, _path, _progress, options) => new Promise((_resolve, reject) => {
    urls.push(url);
    started();
    options.signal.addEventListener('abort', () => reject(
      Object.assign(new Error('aborted'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true });
  });
  const checking = f.manager.check();
  await waiting;
  await f.manager.cancel();
  const state = await checking;
  assert.equal(state.status, 'available');
  assert.match(state.message, /取消/);
  assert.deepEqual(urls, [`https://downloads.melodyoblivion.xyz/patches/v1.9.4/${patchName}`]);
});

test('patch downloads use release mirrors, never the package proxy', () => {
  const f = new UpdateManager({ platform: 'win32', arch: 'x64', app: {}, fileSystem: fs, hashFile: async () => 'a'.repeat(64) });
  const url = `https://github.com/leiming2333/The-Melody-of-Oblivion-Remake/releases/download/v1.9.4/${patchName}`;
  const candidates = f.downloadCandidates(url, patchName);
  assert.equal(candidates[0].url, url);
  assert.ok(candidates.some(candidate => candidate.url.includes('ghproxy.net')));
  assert.ok(candidates.every(candidate => !candidate.url.includes('/api/download')));
});

test('a bad patch manifest digest cannot enable a delta path', async t => {
  const f = await fixture(t);
  const manifestAsset = f.release.assets.find(asset => asset.name === 'patch-manifest.json');
  manifestAsset.digest = `sha256:${'f'.repeat(64)}`;
  assert.equal((await f.manager.check()).status, 'downloaded');
  assert.match(f.calls.downloads[0], /full\.exe$/);
});

test('a patch target bound to another version or asset is rejected before download', async t => {
  const f = await fixture(t);
  const manifestAsset = f.release.assets.find(asset => asset.name === 'patch-manifest.json');
  const manifestText = JSON.stringify({
    ...f.manifest, patches: [{ ...f.manifest.patches[0], asset: 'other.exe' }]
  });
  manifestAsset.digest = `sha256:${sha256(manifestText)}`;
  f.manager.fetchImpl = async (url) => {
    if (url.includes('/api/latest-release') || url.includes('/releases/latest')
      || url.includes('github.com/leiming2333')) return response(f.release);
    if (url.includes('patch-manifest.json')) return response(manifestText);
    return response('not found', 404);
  };
  assert.equal((await f.manager.check()).status, 'downloaded');
  assert.match(f.calls.downloads[0], /full\.exe$/);
});
