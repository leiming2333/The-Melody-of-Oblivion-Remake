const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { safePath } = require('./installation-files');

const pending = new Map();

async function digest(filePath) {
  const hash = crypto.createHash('sha256');
  const file = await fs.open(filePath);
  try {
    for await (const chunk of file.createReadStream()) hash.update(chunk);
  } finally {
    await file.close().catch(() => {});
  }
  return hash.digest('hex');
}

async function listFiles(root, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(safePath(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, name));
    else if (entry.isFile()) files.push({ path: name.split(path.sep).join('/'),
      sha256: await digest(safePath(root, name)) });
    else throw new Error('原生库缓存包含不支持的文件类型');
  }
  return files;
}

async function readManifest(directory, key) {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(directory, '.complete.json'), 'utf8'));
    if (marker.version !== 1 || marker.key !== key || !Array.isArray(marker.files)) return null;
    const realDirectory = await fs.realpath(directory);
    for (const entry of marker.files) {
      if (typeof entry.path !== 'string' || !entry.path || !/^[a-f0-9]{64}$/.test(entry.sha256)) return null;
      const filePath = safePath(directory, ...entry.path.split('/'));
      const realPath = await fs.realpath(filePath);
      const relative = path.relative(realDirectory, realPath);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
      if (await digest(filePath) !== entry.sha256) return null;
    }
    return marker.files;
  } catch {
    return null;
  }
}

async function readCache(cacheRoot, key) {
  try {
    const index = JSON.parse(await fs.readFile(path.join(cacheRoot, `${key}.json`), 'utf8'));
    if (typeof index.directory !== 'string'
        || !new RegExp(`^${key}-[a-f0-9-]+$`).test(index.directory)) return null;
    const directory = safePath(cacheRoot, index.directory);
    const files = await readManifest(directory, key);
    return files ? { directory, files } : null;
  } catch {
    return null;
  }
}

async function prepareCache(cacheRoot, key, archivePath, archiveDigest, excludes, extract) {
  const cached = await readCache(cacheRoot, key);
  if (cached) return cached;
  await fs.mkdir(cacheRoot, { recursive: true });
  const staging = await fs.mkdtemp(path.join(cacheRoot, '.extract-'));
  try {
    await extract(archivePath, staging, excludes);
    if (await digest(archivePath) !== archiveDigest) throw new Error('原生库归档在解压期间发生变化，请重试');
    const files = await listFiles(staging);
    await fs.writeFile(path.join(staging, '.complete.json'), JSON.stringify({ version: 1, key, files }));
    // Another process may have finished this archive while we were extracting it.
    const winner = await readCache(cacheRoot, key);
    if (winner) return winner;
    // Publish a new immutable generation; never rename files another game may be copying.
    const name = `${key}-${crypto.randomUUID()}`;
    const directory = path.join(cacheRoot, name);
    await fs.rename(staging, directory);
    const temporaryIndex = path.join(cacheRoot, `.index-${crypto.randomUUID()}.part`);
    try {
      await fs.writeFile(temporaryIndex, JSON.stringify({ directory: name }));
      await fs.rename(temporaryIndex, path.join(cacheRoot, `${key}.json`));
    } finally {
      await fs.rm(temporaryIndex, { force: true }).catch(() => {});
    }
    return { directory, files };
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function copyCachedNativeArchive({ gameDirectory, archivePath, destination, excludes = [], extract }) {
  const cacheRoot = safePath(gameDirectory, 'launcher-cache', 'native-archives');
  const archiveDigest = await digest(archivePath);
  const key = crypto.createHash('sha256').update(archiveDigest)
    .update(JSON.stringify(excludes)).digest('hex');
  const id = path.join(cacheRoot, key);
  let operation = pending.get(id);
  if (!operation) {
    operation = prepareCache(cacheRoot, key, archivePath, archiveDigest, excludes, extract)
      .finally(() => pending.delete(id));
    pending.set(id, operation);
  }
  const { directory, files } = await operation;
  for (const entry of files) {
    const target = safePath(destination, ...entry.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Each game keeps its own DLL copies so concurrent games cannot delete one another's natives.
    await fs.copyFile(safePath(directory, ...entry.path.split('/')), target);
  }
}

module.exports = { copyCachedNativeArchive };
