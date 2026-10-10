const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.(?:c|m)?js$/.test(file) ? [file] : [];
  });
}

const files = ['site.js', ...['src', 'api', 'scripts', 'test'].flatMap(sourceFiles)];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checked ${files.length} JavaScript files`);
