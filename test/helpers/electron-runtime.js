const fs = require('node:fs');
const path = require('node:path');

// Electron 43 downloads its binary when index.js is imported. Test files run
// concurrently, so discover an already installed runtime without importing it.
function getInstalledElectronPath() {
  const directory = path.dirname(require.resolve('electron/package.json'));
  let executable;
  try { executable = fs.readFileSync(path.join(directory, 'path.txt'), 'utf8').trim(); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!executable) return undefined;
  const runtime = path.join(process.env.ELECTRON_OVERRIDE_DIST_PATH ?? path.join(directory, 'dist'), executable);
  try { return fs.statSync(runtime).isFile() ? runtime : undefined; }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

module.exports = { getInstalledElectronPath };
