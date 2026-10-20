'use strict';

// Fetch metadata for the exact versions already locked; this never resolves ranges.
const fs = require('node:fs/promises');
const path = require('node:path');

async function completeLockfile(filename = path.join(__dirname, '../package-lock.json')) {
  const lock = JSON.parse(await fs.readFile(filename, 'utf8'));
  const before = JSON.stringify(Object.fromEntries(Object.entries(lock.packages).map(([key, value]) => [key, value.version])));
  const entries = Object.entries(lock.packages).filter(([name, value]) => name && !value.link);
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < entries.length) {
      const [name, entry] = entries[cursor++];
      const packageName = name.slice(name.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(entry.version)}`, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Registry metadata failed for ${packageName}@${entry.version}: ${response.status}`);
      const metadata = await response.json();
      if (metadata.version !== entry.version || !metadata.dist?.integrity || !metadata.dist?.tarball?.startsWith('https://registry.npmjs.org/')) throw new Error(`Invalid registry metadata for ${name}`);
      if (entry.integrity && entry.integrity !== metadata.dist.integrity) throw new Error(`Integrity changed for ${name}@${entry.version}`);
      entry.resolved = metadata.dist.tarball;
      entry.integrity = metadata.dist.integrity;
    }
  }));
  const after = JSON.stringify(Object.fromEntries(Object.entries(lock.packages).map(([key, value]) => [key, value.version])));
  if (before !== after) throw new Error('Lockfile package versions changed');
  await fs.writeFile(filename, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Completed official registry metadata for ${entries.length} packages; all locked versions preserved.`);
}

if (require.main === module) completeLockfile().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { completeLockfile };
