const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./installation-files');

const STAGING_MARKER = '.melody-installing.json';
const activeDirectories = new Set();
const keyFor = (directory) => process.platform === 'win32' ? directory.toLowerCase() : directory;

async function instancesRoot(gameDirectory, create = false) {
  const root = safePath(gameDirectory, 'melody-instances');
  if (create) await fs.mkdir(root, { recursive: true });
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('整合包实例根目录不能是链接或文件');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return root;
}

async function createStagingDirectory(gameDirectory, instanceId) {
  const root = await instancesRoot(gameDirectory, true);
  const directory = safePath(root, `.installing-${instanceId}`);
  await fs.mkdir(directory); // A collision must never reuse another install.
  activeDirectories.add(keyFor(directory));
  try {
    await require('./downloader').writeJsonAtomic(path.join(directory, STAGING_MARKER), {
      schemaVersion: 1, kind: 'melody-modpack-install', instanceId, ownerPid: process.pid
    });
  } catch (error) {
    activeDirectories.delete(keyFor(directory));
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return directory;
}

async function removeStagingDirectory(gameDirectory, directory) {
  const root = await instancesRoot(gameDirectory);
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith('.installing-')) {
    throw new Error('整合包临时目录不安全');
  }
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('整合包临时目录不能是链接或文件');
    await fs.rm(directory, { recursive: true, force: true });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  finally { activeDirectories.delete(keyFor(directory)); }
}

function releaseStagingDirectory(directory) {
  activeDirectories.delete(keyFor(directory));
}

async function cleanupStaleStaging(gameDirectory) {
  const root = await instancesRoot(gameDirectory);
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith('.installing-')) continue;
    const directory = safePath(root, entry.name);
    if (activeDirectories.has(keyFor(directory))) continue;
    try {
      const markerPath = path.join(directory, STAGING_MARKER);
      const markerStat = await fs.lstat(markerPath);
      if (markerStat.isSymbolicLink() || !markerStat.isFile()) continue;
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
      if (marker.schemaVersion !== 1 || marker.kind !== 'melody-modpack-install'
        || entry.name !== `.installing-${marker.instanceId}`) continue;
      if (Number.isInteger(marker.ownerPid) && marker.ownerPid > 0 && marker.ownerPid !== process.pid) {
        try { process.kill(marker.ownerPid, 0); continue; }
        catch (error) { if (error.code !== 'ESRCH') continue; }
      }
      await removeStagingDirectory(gameDirectory, directory);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        warnings.push(`上次中断安装的临时文件暂时无法清理：${error.message}`);
      }
    }
  }
  return warnings;
}

module.exports = {
  STAGING_MARKER, createStagingDirectory, removeStagingDirectory, releaseStagingDirectory, cleanupStaleStaging
};
