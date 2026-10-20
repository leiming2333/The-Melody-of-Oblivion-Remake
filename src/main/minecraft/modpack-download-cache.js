const fs = require('node:fs/promises');
const streamFs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { downloadFile, fileMatches, safePath, throwIfAborted } = require('./downloader');

// Share the queue between manager objects so two installs never write the same
// cached artifact (including its downloader .part file) at once.
const pending = new Map();

function cachePathFor(task, cacheRoot) {
  if (!/^[0-9a-f]{40}$/i.test(task.sha1 ?? '')) return undefined;
  return safePath(cacheRoot, task.sha1.toLowerCase());
}

async function publishCacheFile(candidatePath, cachedPath, signal) {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    try { await fs.rename(candidatePath, cachedPath); return; }
    catch (error) {
      if (process.platform !== 'win32' || attempt >= 4
        || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      await delay(10 * (2 ** attempt), undefined, { signal });
    }
  }
}

async function hasCachedModpackFile(task, cacheRoot) {
  const cachedPath = cachePathFor(task, cacheRoot);
  return Boolean(cachedPath) && fileMatches(cachedPath, { ...task, sha1: task.sha1.toLowerCase() });
}

async function withCacheQueue(key, operation) {
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  pending.set(key, current);
  try {
    return await current;
  } finally {
    if (pending.get(key) === current) pending.delete(key);
  }
}

async function downloadModpackFile(task, cacheRoot) {
  // Without a trusted manifest hash a nonempty file/size match is insufficient
  // evidence to persist and reuse an artifact across installation attempts.
  if (!/^[0-9a-f]{40}$/i.test(task.sha1 ?? '')) return downloadFile(task);
  const sha1 = task.sha1.toLowerCase();
  const cachedPath = safePath(cacheRoot, sha1);
  return withCacheQueue(path.resolve(cachedPath), async () => {
    throwIfAborted(task.signal);
    const cachedTask = { ...task, sha1, destination: cachedPath };
    let result;
    if (await fileMatches(cachedPath, cachedTask)) {
      result = {
        skipped: true,
        bytes: (await fs.stat(cachedPath)).size,
        segmented: false,
        segments: 0
      };
    } else {
      await fs.mkdir(cacheRoot, { recursive: true });
      const temporaryRoot = await fs.mkdtemp(path.join(cacheRoot, '.download-'));
      try {
        const candidatePath = path.join(temporaryRoot, 'artifact');
        result = await downloadFile({ ...cachedTask, destination: candidatePath });
        throwIfAborted(task.signal);
        // Publish only a complete, hash-checked artifact. Replacing corrupt cache
        // entries leaves the previous file in place if the rename fails.
        await publishCacheFile(candidatePath, cachedPath, task.signal);
      } finally {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    }
    throwIfAborted(task.signal);
    await fs.mkdir(path.dirname(task.destination), { recursive: true });
    await fs.copyFile(cachedPath, task.destination);
    if (!(await fileMatches(task.destination, { ...task, sha1 }))) {
      throw new Error(`整合包缓存文件校验失败：${task.label}`);
    }
    return result;
  });
}

async function importModpackFile(task, sourcePath, cacheRoot) {
  const cachedPath = cachePathFor(task, cacheRoot);
  if (!cachedPath) throw Object.assign(new Error('缺少可信的 SHA-1，无法校验手动文件，请重新查询文件信息'), {
    code: 'MODPACK_METADATA_UNAVAILABLE', phase: 'resolving-files', retryable: true
  });
  return withCacheQueue(path.resolve(cachedPath), async () => {
    throwIfAborted(task.signal);
    const sourceStat = await fs.stat(sourcePath);
    if (!sourceStat.isFile() || (Number.isFinite(task.size) && sourceStat.size !== task.size)) {
      throw Object.assign(new Error('所选文件大小与整合包要求不符，请选择对应版本的文件'), {
        code: 'MODPACK_FILE_MISMATCH', phase: 'importing-files', retryable: true
      });
    }
    await fs.mkdir(cacheRoot, { recursive: true });
    const temporaryRoot = await fs.mkdtemp(path.join(cacheRoot, '.download-'));
    try {
      const candidatePath = path.join(temporaryRoot, 'artifact');
      await pipeline(streamFs.createReadStream(sourcePath), streamFs.createWriteStream(candidatePath, { flags: 'wx' }),
        { signal: task.signal });
      // Verify the copy, since the selected source can change while it is read.
      if (!(await fileMatches(candidatePath, { ...task, sha1: task.sha1.toLowerCase() }))) {
        throw Object.assign(new Error('所选文件校验失败，请下载整合包要求的准确文件版本'), {
          code: 'MODPACK_FILE_MISMATCH', phase: 'importing-files', retryable: true
        });
      }
      throwIfAborted(task.signal);
      await publishCacheFile(candidatePath, cachedPath, task.signal);
      return { bytes: (await fs.stat(cachedPath)).size, sha1: task.sha1.toLowerCase() };
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}

module.exports = { downloadModpackFile, hasCachedModpackFile, importModpackFile };
