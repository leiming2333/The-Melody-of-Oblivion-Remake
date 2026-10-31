const fsPromises = require('node:fs/promises');
const path = require('node:path');
const INSTALLATION_MARKER_FILE = '.melody-installed.json';

function safePath(root, ...segments) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('下载目标路径不安全');
  }
  return resolvedTarget;
}

function installationMarkerPath(gameDirectory, profileId) {
  return safePath(gameDirectory, 'versions', profileId, INSTALLATION_MARKER_FILE);
}

async function readInstallationMarkerState(gameDirectory, profileId) {
  const incomplete = { complete: false, coversInheritance: false };
  try {
    const marker = JSON.parse(await fsPromises.readFile(
      installationMarkerPath(gameDirectory, profileId),
      'utf8'
    ));
    if (marker.schemaVersion !== 1 || marker.profileId !== profileId
        || !Array.isArray(marker.files) || marker.files.length === 0) return incomplete;
    let position = 0;
    let valid = true;
    await Promise.all(Array.from({ length: Math.min(8, marker.files.length) }, async () => {
      while (valid && position < marker.files.length) {
        const entry = marker.files[position++];
        if (!entry || typeof entry.path !== 'string' || !entry.path) { valid = false; break; }
        const filePath = safePath(gameDirectory, ...entry.path.split('/'));
        const stat = await fsPromises.stat(filePath);
        if (!stat.isFile() || (stat.size === 0 && entry.size !== 0)
            || (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0 || stat.size !== entry.size))) {
          valid = false;
        }
      }
    }));
    return { complete: valid, coversInheritance: valid && marker.coversInheritance === true };
  } catch {
    return incomplete;
  }
}

async function hasInstallationMarker(gameDirectory, profileId) {
  return (await readInstallationMarkerState(gameDirectory, profileId)).complete;
}

module.exports = { safePath, installationMarkerPath, hasInstallationMarker, readInstallationMarkerState, INSTALLATION_MARKER_FILE };
