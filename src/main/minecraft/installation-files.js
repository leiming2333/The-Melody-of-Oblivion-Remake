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

async function hasInstallationMarker(gameDirectory, profileId) {
  try {
    const marker = JSON.parse(await fsPromises.readFile(
      installationMarkerPath(gameDirectory, profileId),
      'utf8'
    ));
    return marker.schemaVersion === 1
      && marker.profileId === profileId
      && Array.isArray(marker.files);
  } catch {
    return false;
  }
}

module.exports = { safePath, installationMarkerPath, hasInstallationMarker, INSTALLATION_MARKER_FILE };
