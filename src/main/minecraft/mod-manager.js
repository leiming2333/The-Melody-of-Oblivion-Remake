const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

function validateModName(name) {
  if (typeof name !== 'string' || /[\\/\0]/.test(name) || !/\.jar(?:\.disabled)?$/i.test(name)) {
    throw new Error('Mod 文件名无效');
  }
  return name;
}

class ModManager {
  constructor() { this.queues = new Map(); }

  async directory(instanceDirectory) {
    // Refuse redirects at the selected instance and its mods directory.
    const mods = path.join(instanceDirectory, 'mods');
    for (const directory of [instanceDirectory, mods]) {
      try {
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Mod 目录不能是链接或普通文件');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.mkdir(directory, { recursive: true });
      }
    }
    return mods;
  }

  async list(instanceDirectory) {
    const directory = await this.directory(instanceDirectory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && /\.jar(?:\.disabled)?$/i.test(entry.name))
      .map(entry => ({ name: entry.name, enabled: !/\.disabled$/i.test(entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  exclusive(directory, operation) {
    const previous = this.queues.get(directory) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.queues.set(directory, task);
    return task.finally(() => { if (this.queues.get(directory) === task) this.queues.delete(directory); });
  }

  setEnabled(instanceDirectory, name, enabled) {
    validateModName(name);
    if (typeof enabled !== 'boolean') throw new Error('Mod 状态无效');
    return this.exclusive(instanceDirectory, async () => {
      const directory = await this.directory(instanceDirectory);
      const source = path.join(directory, name);
      const info = await fs.lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Mod 文件不能是链接');
      const targetName = enabled ? name.replace(/\.disabled$/i, '') : /\.disabled$/i.test(name) ? name : `${name}.disabled`;
      if (name !== targetName) {
        // link() fails if a destination exists, avoiding rename's overwrite behavior.
        try { await fs.link(source, path.join(directory, targetName)); }
        catch (error) {
          if (error.code === 'EEXIST') throw new Error('同名 Mod 已存在，请先检查两个文件');
          throw error;
        }
        try { await fs.unlink(source); }
        catch (error) { await fs.unlink(path.join(directory, targetName)).catch(() => {}); throw error; }
      }
      return this.list(instanceDirectory);
    });
  }

  importFile(instanceDirectory, source) {
    const name = validateModName(path.basename(source));
    if (!/\.jar$/i.test(name)) throw new Error('请选择 .jar Mod 文件');
    return this.exclusive(instanceDirectory, async () => {
      const info = await fs.lstat(source);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Mod 文件不能是链接');
      const directory = await this.directory(instanceDirectory);
      try { await fs.copyFile(source, path.join(directory, name), constants.COPYFILE_EXCL); }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('同名 Mod 已存在，未覆盖现有文件');
        throw error;
      }
      return this.list(instanceDirectory);
    });
  }
}

module.exports = { ModManager, validateModName };
