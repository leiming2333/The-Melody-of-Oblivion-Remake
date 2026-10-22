const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const streamFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModpackManager, copyDirectoryContents } = require('../src/main/minecraft/modpack-manager');
const { MinecraftVersionManager } = require('../src/main/minecraft/version-manager');
const { STAGING_MARKER, createStagingDirectory, releaseStagingDirectory,
  cleanupStaleStaging, removeStagingDirectory } = require('../src/main/minecraft/modpack-staging');

function zip(entries) {
  let offset = 0;
  const files = [], directory = [];
  for (const [filename, value] of entries) {
    const name = Buffer.from(filename), content = Buffer.from(value);
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    files.push(local, name, content); directory.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

const sha1 = (content) => crypto.createHash('sha1').update(content).digest('hex');
async function fixture(t, { format = 'curseforge', files = [], extra = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'melody-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, format === 'curseforge' ? 'pack.zip' : 'pack.mrpack');
  const manifest = format === 'curseforge'
    ? { manifestType: 'minecraftModpack', name: 'Recovery Pack', minecraft: { version: '1.21.1' }, files }
    : { formatVersion: 1, game: 'minecraft', name: 'Recovery Pack', dependencies: { minecraft: '1.21.1' }, files };
  await fs.writeFile(archive, zip([[format === 'curseforge' ? 'manifest.json' : 'modrinth.index.json',
    JSON.stringify(manifest)], ...extra]));
  let baseCalls = 0;
  const gameDirectory = path.join(root, 'game');
  const manager = new ModpackManager({ gameDirectory, concurrency: 2,
    loaderManager: { installLoader: async () => { baseCalls++; return { profileId: '1.21.1' }; } },
    lookupHost: async () => [{ address: '8.8.8.8', family: 4 }] });
  return { root, archive, manager, gameDirectory, baseCalls: () => baseCalls };
}

function metadata(fileId, content, downloadUrl = null, fileName = `mod-${fileId}.jar`) {
  return { id: fileId, modId: 1, fileName, fileLength: Buffer.byteLength(content), downloadUrl,
    hashes: [{ algo: 1, value: sha1(content) }] };
}

test('restricted CF files wait after downloads settle, verify manual copies, resume and reuse cache after restart', async t => {
  const f = await fixture(t, { files: [{ projectID: 1, fileID: 11 }, { projectID: 1, fileID: 12 }] });
  const automatic = 'automatic mod', manual = 'manual mod';
  let downloads = 0, queries = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('api.curse.tools')) {
      queries++;
      const id = Number(String(url).split('/').at(-1));
      return Response.json({ data: metadata(id, id === 11 ? automatic : manual,
        id === 11 ? 'https://example.com/mod.jar' : null) });
    }
    downloads++; return new Response(automatic);
  });
  const waiting = await f.manager.install(f.archive, () => {}, { ownerId: 7 });
  assert.equal(waiting.status, 'waiting-for-files');
  assert.equal(waiting.files.length, 1);
  assert.equal(waiting.files[0].reason, 'restricted');
  assert.equal(waiting.files[0].canImport, true);
  assert.match(waiting.files[0].officialUrl, /^https:\/\/www\.curseforge\.com\//);
  assert.equal(JSON.stringify(waiting).includes(f.root), false);
  assert.deepEqual(await fs.readdir(path.join(f.gameDirectory, 'melody-instances')), []);
  assert.equal(downloads, 1);
  assert.throws(() => f.manager.getRecoveryState(waiting.sessionId, { ownerId: 8 }), { code: 'MODPACK_SESSION_EXPIRED' });
  const chosen = path.join(f.root, 'renamed (1).jar');
  await fs.writeFile(chosen, 'x'.repeat(manual.length));
  await assert.rejects(f.manager.importMissingFile(waiting.sessionId,
    { projectId: 1, fileId: 12, filePath: chosen }, { ownerId: 7 }), { code: 'MODPACK_FILE_MISMATCH' });
  await fs.writeFile(chosen, manual);
  const supplied = await f.manager.importMissingFile(waiting.sessionId,
    { projectId: 1, fileId: 12, filePath: chosen }, { ownerId: 7 });
  assert.equal(supplied.canResume, true);
  const copyFailure = t.mock.method(fs, 'copyFile', async () => {
    throw Object.assign(new Error('permission'), { code: 'EACCES' });
  });
  await assert.rejects(f.manager.resume(waiting.sessionId, () => {}, { ownerId: 7 }), { code: 'EACCES' });
  assert.equal(f.manager.getRecoveryState(waiting.sessionId, { ownerId: 7 }).canResume, true);
  copyFailure.mock.restore();
  const result = await f.manager.resume(waiting.sessionId, () => {}, { ownerId: 7 });
  assert.equal(result.status, 'complete');
  assert.equal(downloads, 1);
  assert.equal(queries, 2);
  assert.equal(await fs.readFile(path.join(f.gameDirectory, 'melody-instances', result.instanceId,
    'mods/mod-12.jar'), 'utf8'), manual);
  assert.equal(f.manager.sessions.size, 0);
  const restarted = new ModpackManager({ gameDirectory: f.gameDirectory, loaderManager: f.manager.loaderManager,
    lookupHost: f.manager.lookupHost });
  assert.equal((await restarted.install(f.archive)).status, 'complete');
  assert.equal(downloads, 1);
});

test('a waiting CF recovery session survives restart and is claimed by the new window', async t => {
  const f = await fixture(t, { files: [{ projectID: 1, fileID: 21 }] });
  const manual = 'persisted manual mod';
  t.mock.method(globalThis, 'fetch', async url => {
    if (String(url).includes('api.curse.tools')) {
      return Response.json({ data: metadata(21, manual, null, 'persisted.jar') });
    }
    throw new Error('unexpected download');
  });
  const waiting = await f.manager.install(f.archive, () => {}, { ownerId: 7 });
  assert.equal(waiting.status, 'waiting-for-files');
  f.manager.releaseOwnerSessions(7);

  const persisted = await fs.readFile(path.join(f.gameDirectory, 'launcher-cache', 'modpack-recovery.json'), 'utf8');
  assert.equal(persisted.includes('ownerId'), false);
  assert.equal(persisted.includes('.installing-'), false);

  const restarted = new ModpackManager({ gameDirectory: f.gameDirectory, loaderManager: f.manager.loaderManager,
    lookupHost: f.manager.lookupHost });
  const restored = await restarted.claimRecoverySession(9);
  assert.equal(restored.sessionId, waiting.sessionId);
  assert.equal(restored.sourceName, 'pack.zip');
  assert.equal(restored.files[0].fileName, 'persisted.jar');
  assert.throws(() => restarted.getRecoveryState(waiting.sessionId, { ownerId: 7 }),
    { code: 'MODPACK_SESSION_EXPIRED' });

  const chosen = path.join(f.root, 'persisted.jar');
  await fs.writeFile(chosen, manual);
  await restarted.importMissingFile(waiting.sessionId,
    { projectId: 1, fileId: 21, filePath: chosen }, { ownerId: 9 });
  const result = await restarted.resume(waiting.sessionId, () => {}, { ownerId: 9 });
  assert.equal(result.status, 'complete');
  await assert.rejects(fs.stat(path.join(f.gameDirectory, 'launcher-cache', 'modpack-recovery.json')),
    { code: 'ENOENT' });
});

test('CurseForge metadata retries a transient service failure before asking for manual recovery', async t => {
  const f = await fixture(t, { files: [{ projectID: 1, fileID: 31 }] });
  let queries = 0;
  t.mock.method(globalThis, 'fetch', async url => {
    if (!String(url).includes('api.curse.tools')) throw new Error('unexpected download');
    queries += 1;
    return queries === 1 ? new Response(null, { status: 503 })
      : Response.json({ data: metadata(31, 'manual', null, 'retry.jar') });
  });
  const waiting = await f.manager.install(f.archive);
  assert.equal(queries, 2);
  assert.equal(waiting.files[0].reason, 'restricted');
  assert.equal(waiting.files[0].canImport, true);
});

test('missing CF metadata permits only a query retry, and archive or game-directory changes invalidate recovery', async t => {
  const f = await fixture(t, { files: [{ projectID: 1, fileID: 11 }] });
  let available = false;
  t.mock.method(globalThis, 'fetch', async () => available
    ? Response.json({ data: metadata(11, 'content') }) : new Response(null, { status: 503 }));
  const pending = await f.manager.install(f.archive, () => {}, { ownerId: 'owner' });
  assert.equal(pending.files[0].canImport, false);
  await assert.rejects(f.manager.importMissingFile(pending.sessionId,
    { projectId: 1, fileId: 11, filePath: path.join(f.root, 'arbitrary.jar') }, { ownerId: 'owner' }),
  { code: 'MODPACK_METADATA_UNAVAILABLE' });
  available = true;
  const refreshed = await f.manager.resume(pending.sessionId, () => {}, { ownerId: 'owner' });
  assert.equal(refreshed.files[0].canImport, true);
  f.manager.gameDirectory = path.join(f.root, 'other');
  assert.throws(() => f.manager.getRecoveryState(pending.sessionId, { ownerId: 'owner' }),
    { code: 'MODPACK_SESSION_EXPIRED' });
  f.manager.gameDirectory = f.gameDirectory;
  await fs.appendFile(f.archive, 'changed');
  await assert.rejects(f.manager.resume(pending.sessionId, () => {}, { ownerId: 'owner' }),
    { code: 'MODPACK_ARCHIVE_CHANGED' });
});

test('CF exhausted remote downloads can be supplied manually, while optional remote failures produce warnings', async t => {
  const f = await fixture(t, { files: [{ projectID: 1, fileID: 11 }, { projectID: 1, fileID: 12, required: false }] });
  t.mock.method(globalThis, 'fetch', async url => String(url).includes('api.curse.tools')
    ? Response.json({ data: metadata(Number(String(url).split('/').at(-1)),
      String(url).endsWith('/11') ? 'content' : 'optional content', 'https://example.com/mod.jar') })
    : new Response(null, { status: 503 }));
  const waiting = await f.manager.install(f.archive, () => {}, { installOptionalFiles: true, ownerId: 1 });
  assert.equal(waiting.files.length, 1);
  assert.equal(waiting.files[0].reason, 'download-failed');
  const chosen = path.join(f.root, 'manual.jar'); await fs.writeFile(chosen, 'content');
  await f.manager.importMissingFile(waiting.sessionId, { projectId: 1, fileId: 11, filePath: chosen }, { ownerId: 1 });
  const result = await f.manager.resume(waiting.sessionId, () => {}, { ownerId: 1 });
  assert.equal(result.status, 'complete');
  assert.equal(result.warnings.length, 1);
});

test('a Modrinth optional remote failure is nonfatal, but a local cache-copy error remains fatal', async t => {
  const content = 'required';
  const f = await fixture(t, { format: 'modrinth', files: [
    { path: 'mods/required.jar', downloads: ['https://example.com/required'], hashes: { sha1: sha1(content) } },
    { path: 'mods/optional.jar', downloads: ['https://example.com/optional'], env: { client: 'optional' } }
  ] });
  t.mock.method(globalThis, 'fetch', async url => String(url).endsWith('optional')
    ? new Response(null, { status: 503 }) : new Response(content));
  const result = await f.manager.install(f.archive, () => {}, { installOptionalFiles: true });
  assert.equal(result.status, 'complete');
  assert.equal(result.warnings.length, 1);
  t.mock.method(fs, 'copyFile', async () => { throw Object.assign(new Error('permission'), { code: 'EACCES' }); });
  await assert.rejects(f.manager.install(f.archive), { code: 'EACCES' });
});

test('extraction and override copies honor cancellation before another file or loader starts', async t => {
  const f = await fixture(t, { format: 'modrinth', extra: [['overrides/a', 'a'], ['overrides/b', 'b']] });
  const controller = new AbortController();
  await assert.rejects(f.manager.install(f.archive, progress => {
    if (progress.phase === 'extracting') controller.abort();
  }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.baseCalls(), 0);
  const source = path.join(f.root, 'source'), destination = path.join(f.root, 'destination');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'a'), 'x'.repeat(1024 * 1024));
  await fs.writeFile(path.join(source, 'b'), 'next');
  const copyController = new AbortController(), original = streamFs.createReadStream;
  t.mock.method(streamFs, 'createReadStream', (...args) => {
    const input = original(...args); input.once('data', () => copyController.abort()); return input;
  });
  await assert.rejects(copyDirectoryContents(source, destination, { signal: copyController.signal }), { name: 'AbortError' });
  await assert.rejects(fs.stat(path.join(destination, 'b')), { code: 'ENOENT' });
});

test('commit boundary rejects cancellation before publication and reports a noncancellable atomic commit', async t => {
  const f = await fixture(t, { format: 'modrinth' });
  const before = new AbortController(), rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (source, destination) => {
    await rename(source, destination);
    if (path.basename(destination) === '.melody-instance.json') before.abort();
  });
  await assert.rejects(f.manager.install(f.archive, () => {}, { signal: before.signal }), { name: 'AbortError' });
  assert.deepEqual(await fs.readdir(path.join(f.gameDirectory, 'melody-instances')), []);
  mock.mock.restore();
  const after = new AbortController(); let boundary = false;
  const result = await f.manager.install(f.archive, progress => {
    if (progress.phase === 'committing-instance') { boundary = true; assert.equal(progress.cancellable, false); after.abort(); }
  }, { signal: after.signal });
  assert.equal(boundary, true); assert.equal(result.status, 'complete');
  assert.equal((await fs.stat(path.join(f.gameDirectory, 'melody-instances', result.instanceId))).isDirectory(), true);
});

test('only owned inactive staging is reclaimed and internal directories stay hidden', async t => {
  const f = await fixture(t, { format: 'modrinth' });
  const stale = await createStagingDirectory(f.gameDirectory, 'stale'); releaseStagingDirectory(stale);
  const active = await createStagingDirectory(f.gameDirectory, 'active');
  const unknown = path.join(f.gameDirectory, 'melody-instances', '.installing-user'); await fs.mkdir(unknown);
  await fs.writeFile(path.join(unknown, '.melody-instance.json'), JSON.stringify({ schemaVersion: 1,
    instanceId: 'user', name: 'not an instance', profileId: '1.21.1' }));
  const versionManager = new MinecraftVersionManager({ gameDirectory: f.gameDirectory });
  assert.deepEqual((await versionManager.listLocalProfiles()).profiles, []);
  await assert.rejects(fs.stat(stale), { code: 'ENOENT' });
  assert.equal((await fs.stat(active)).isDirectory(), true);
  assert.equal((await fs.stat(unknown)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(active, STAGING_MARKER))).isFile(), true);
  await removeStagingDirectory(f.gameDirectory, active);
  assert.deepEqual(await cleanupStaleStaging(f.gameDirectory), []);
});

test('staging cleanup does not follow a junction outside the instance root', async t => {
  const f = await fixture(t, { format: 'modrinth' });
  const external = path.join(f.root, 'external'); await fs.mkdir(external);
  await fs.writeFile(path.join(external, STAGING_MARKER), JSON.stringify({ schemaVersion: 1,
    kind: 'melody-modpack-install', instanceId: 'linked' }));
  await fs.writeFile(path.join(external, 'keep.txt'), 'keep');
  await fs.mkdir(path.join(f.gameDirectory, 'melody-instances'), { recursive: true });
  const link = path.join(f.gameDirectory, 'melody-instances', '.installing-linked');
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  await cleanupStaleStaging(f.gameDirectory);
  assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'keep');
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
});

test('cleanup failures retain the original installation error and its retry details', async t => {
  const f = await fixture(t, { format: 'modrinth', extra: [['overrides/.melody-instance.json', 'reserved']] });
  const remove = fs.rm;
  t.mock.method(fs, 'rm', async (target, options) => {
    if (path.basename(target).startsWith('.installing-')) throw Object.assign(new Error('sharing lock'), { code: 'EPERM' });
    return remove(target, options);
  });
  await assert.rejects(f.manager.install(f.archive), error => {
    assert.equal(error.code, 'MODPACK_INVALID_METADATA');
    assert.match(error.message, /覆盖文件/);
    assert.match(error.details.cleanupMessage, /清理失败/);
    return true;
  });
});

test('stale cleanup preserves staging owned by another live launcher process', async t => {
  const f = await fixture(t);
  const directory = await createStagingDirectory(f.gameDirectory, 'other-process');
  releaseStagingDirectory(directory);
  const marker = path.join(directory, STAGING_MARKER);
  const ownerPid = process.pid + 100000;
  await fs.writeFile(marker, JSON.stringify({ schemaVersion: 1, kind: 'melody-modpack-install',
    instanceId: 'other-process', ownerPid }));
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, ownerPid); assert.equal(signal, 0); return true;
  });
  await cleanupStaleStaging(f.gameDirectory);
  assert.equal((await fs.stat(directory)).isDirectory(), true);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('process exited'), { code: 'ESRCH' }); });
  await cleanupStaleStaging(f.gameDirectory);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('inspection and direct installation consistently reject duplicate, encrypted and malformed ZIP directories', async t => {
  const f = await fixture(t, { format: 'modrinth' });
  const index = JSON.stringify({ formatVersion: 1, game: 'minecraft', dependencies: { minecraft: '1.21.1' }, files: [] });
  const duplicate = zip([['modrinth.index.json', index], ['overrides/a', 'one'], ['overrides/A', 'two']]);
  const encrypted = zip([['modrinth.index.json', index]]);
  const offset = encrypted.readUInt32LE(encrypted.length - 6); encrypted.writeUInt16LE(1, offset + 8);
  const malformed = zip([['modrinth.index.json', index]]); malformed.writeUInt32LE(0xfffffff0, malformed.length - 6);
  for (const archive of [duplicate, encrypted, malformed]) {
    await fs.writeFile(f.archive, archive);
    await assert.rejects(f.manager.inspect(f.archive));
    await assert.rejects(f.manager.install(f.archive));
  }
  assert.equal(f.baseCalls(), 0);
});
