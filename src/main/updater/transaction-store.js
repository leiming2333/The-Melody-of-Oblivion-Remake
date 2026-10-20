const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PHASES = new Set(['prepared', 'applying', 'awaiting-health', 'confirmed', 'rolled-back', 'failed', 'abandoned']);

function identity(value, platform) {
  const resolved = path.resolve(value);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function transactionPaths(target, id, platform) {
  if (!UUID.test(id)) throw new Error('更新事务标识无效');
  const directory = path.dirname(path.resolve(target));
  return {
    stagingRoot: platform === 'win32'
      ? path.join(directory, 'Melody', 'updates', id)
      : path.join(directory, '.melody-updates', id),
    backupPath: `${path.resolve(target)}.old-${id}`
  };
}

async function assertManagedAncestors(fileSystem, entryPath, root) {
  if (!fileSystem.lstat) return;
  const relative = path.relative(path.resolve(root), path.resolve(entryPath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('更新路径不在受管目录中');
  }
  let current = path.resolve(entryPath);
  const stop = path.resolve(root);
  while (true) {
    try {
      const stat = await fileSystem.lstat(current);
      if (stat.isSymbolicLink()) throw Object.assign(new Error('更新路径包含符号链接，无法安全安装'), { code: 'UPDATE_UNSAFE_PATH' });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === stop) break;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('更新路径不在受管目录中');
    current = parent;
  }
}

class TransactionStore {
  constructor({ directory, target, platform, fileSystem = fs }) {
    this.fs = fileSystem;
    this.target = path.resolve(target);
    this.platform = platform;
    this.key = crypto.createHash('sha256').update(`${platform}\0${identity(target, platform)}`).digest('hex');
    this.filePath = path.join(directory, `${this.key}.json`);
    this.records = [];
    this.queue = Promise.resolve();
    // Lightweight injected filesystems used by callers can opt out of persistence.
    this.persistent = typeof this.fs.readFile === 'function' && typeof this.fs.writeFile === 'function';
  }

  valid(record) {
    if (!record || !UUID.test(record.id) || !PHASES.has(record.phase)
      || (record.rollbackOf && !UUID.test(record.rollbackOf))
      || record.platform !== this.platform
      || typeof record.targetPath !== 'string'
      || identity(record.targetPath, this.platform) !== identity(this.target, this.platform)) return false;
    const expected = transactionPaths(this.target, record.id, this.platform);
    const packageRoot = path.join(path.dirname(this.filePath), 'packages', record.id);
    const sourceAllowed = path.dirname(record.sourcePath ?? '') === record.stagingRoot
      || (this.platform === 'darwin' && path.dirname(record.sourcePath ?? '') === packageRoot);
    return record.backupPath === expected.backupPath && record.stagingRoot === expected.stagingRoot
      && typeof record.sourcePath === 'string'
      && sourceAllowed
      && (!record.downloadPath || (this.platform === 'darwin' && !record.rollbackOf
        ? path.dirname(record.downloadPath) === packageRoot : path.dirname(record.downloadPath) === record.stagingRoot))
      && /^[a-f0-9]{64}$/i.test(record.sha256 ?? '')
      && typeof record.toVersion === 'string' && typeof record.fromVersion === 'string';
  }

  async load() {
    if (!this.persistent) return this.records;
    try {
      const report = JSON.parse(await this.fs.readFile(this.filePath, 'utf8'));
      if (report.schema !== 1 || report.key !== this.key || !Array.isArray(report.records)) {
        throw new Error('更新恢复记录格式无效，已保留原文件');
      }
      if (report.records.some((record) => !this.valid(record))) {
        throw new Error('更新恢复记录路径无效，已保留原文件');
      }
      this.records = report.records;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this.records;
  }

  async save(record) {
    if (!this.valid(record)) throw new Error('更新事务路径无效');
    const index = this.records.findIndex((entry) => entry.id === record.id);
    if (index >= 0) this.records[index] = { ...record };
    else this.records.push({ ...record });
    const report = JSON.stringify({ schema: 1, key: this.key, records: this.records }, null, 2);
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!this.persistent) return;
      await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await this.fs.writeFile(temporary, report, { mode: 0o600 });
        await this.fs.rename(temporary, this.filePath);
      } finally {
        await this.fs.rm(temporary, { force: true }).catch(() => {});
      }
    });
    await this.queue;
    return record;
  }

  latest() { return this.records.at(-1) ?? null; }
}

module.exports = { TransactionStore, identity, transactionPaths, assertManagedAncestors };
