const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// electron-builder does not expose a custom script option for the portable target.
// Replace only this target's final script through the public afterPack hook.
module.exports = async function portableBuildHook(context) {
  if (context.electronPlatformName !== 'win32') return;
  const target = context.targets.find((item) => item.name === 'portable');
  if (!target) return;
  const hash = crypto.createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), name);
      else {
        hash.update(name.replaceAll('\\', '/'));
        hash.update('\0');
        const file = await fs.open(path.join(directory, entry.name));
        try {
          for await (const chunk of file.createReadStream()) hash.update(chunk);
        } finally {
          await file.close().catch(() => {});
        }
      }
    }
  }
  await visit(context.appOutDir);
  target.melodyCacheKeys ??= new Map();
  target.melodyCacheKeys.set(context.arch, hash.digest('hex'));
  if (target.melodyPortableScriptApplied) return;
  if (typeof target.computeFinalScript !== 'function') {
    throw new Error('electron-builder portable script API changed; refusing to build a nonpersistent EXE');
  }
  const original = target.computeFinalScript;
  target.computeFinalScript = async function (defaultScript, isInstaller, archs) {
    if (!defaultScript.includes('PORTABLE_EXECUTABLE_DIR')) {
      throw new Error('Unexpected electron-builder portable template');
    }
    let defines = '';
    for (const arch of archs.keys()) {
      const suffix = { 0: '32', 1: '64', 3: 'ARM64' }[arch];
      const key = this.melodyCacheKeys.get(arch);
      if (!suffix || !key) throw new Error(`Missing portable runtime fingerprint for architecture ${arch}`);
      defines += `!define MELODY_CACHE_${suffix} "${suffix}-${key}"\n`;
    }
    const script = await fs.readFile(path.join(__dirname, '../build/portable.nsi'), 'utf8');
    return original.call(this, defines + script, isInstaller, archs);
  };
  target.melodyPortableScriptApplied = true;
};
