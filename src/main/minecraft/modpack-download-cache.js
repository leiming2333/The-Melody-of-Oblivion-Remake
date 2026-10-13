const fs = require('node:fs/promises');
const path = require('node:path');
const { downloadFile, fileMatches, safePath, throwIfAborted } = require('./downloader');

// Share the queue between manager objects so two installs never write the same
// cached artifact (including its downloader .part file) at once.
const pending = new Map();

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
        await fs.rename(candidatePath, cachedPath);
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

module.exports = { downloadModpackFile };
