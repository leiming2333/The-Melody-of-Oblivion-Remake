const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { runFileExclusive } = require('./file-write-queue');

const ownedFiles = new AsyncLocalStorage();

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Backups contain the original serialized bytes, before account secrets are decoded.
class RecoverableJsonStore {
  constructor(filePath, { validate, label }) {
    this.filePath = path.resolve(filePath);
    this.backupPath = `${this.filePath}.bak`;
    this.validate = validate;
    this.label = label;
    this.key = process.platform === 'win32' ? this.filePath.toLowerCase() : this.filePath;
    this.recovery = null;
  }

  runExclusive(operation) {
    if (ownedFiles.getStore()?.has(this.key)) return operation();
    return runFileExclusive(this.filePath, () => ownedFiles.run(
      new Set([...(ownedFiles.getStore() ?? []), this.key]), operation
    ));
  }

  async snapshot(filePath) {
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
    } catch (error) {
      if (error.code === 'ENOENT') return { missing: true };
      throw error;
    }
    try {
      const bytes = await handle.readFile();
      const stat = await handle.stat();
      // Never introduce group/other access when copying sensitive configuration.
      const mode = stat.mode & 0o600;
      try {
        const value = JSON.parse(bytes.toString('utf8'));
        this.validate(value);
        return { bytes, mode, value };
      } catch (error) {
        // JSON parser messages can quote configuration bytes, including tokens.
        return { bytes, mode, error: error instanceof SyntaxError ? new Error('JSON 语法无效') : error };
      }
    } finally {
      await handle.close();
    }
  }

  async atomicWrite(filePath, bytes, mode = 0o600) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.part-${randomUUID()}`;
    try {
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode });
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async quarantine(snapshot) {
    const digest = createHash('sha256').update(snapshot.bytes).digest('hex').slice(0, 16);
    const quarantinePath = `${this.filePath}.corrupt-${digest}`;
    try {
      await fs.writeFile(quarantinePath, snapshot.bytes, { flag: 'wx', mode: snapshot.mode });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return quarantinePath;
  }

  async read() {
    const current = await this.snapshot(this.filePath);
    if (!current.missing && !current.error) return current.value;
    return this.runExclusive(async () => {
      // A concurrent writer may already have repaired or replaced the file.
      const latest = await this.snapshot(this.filePath);
      if (!latest.missing && !latest.error) return latest.value;
      const backup = await this.snapshot(this.backupPath);
      if (latest.missing && backup.missing) return undefined;
      const quarantinePath = latest.error ? await this.quarantine(latest) : undefined;
      if (backup.missing || backup.error) {
        const error = new Error(`${this.label}已损坏，且没有有效备份。原文件已保留，请先恢复配置后重试。\n文件：${this.filePath}${quarantinePath ? `\n损坏副本：${quarantinePath}` : ''}\n备份：${this.backupPath}`,
          { cause: latest.error ?? backup.error });
        error.code = 'CONFIG_CORRUPT';
        throw error;
      }
      await this.atomicWrite(this.filePath, backup.bytes, backup.mode);
      this.recovery = { filePath: this.filePath, backupPath: this.backupPath, quarantinePath };
      return backup.value;
    });
  }

  write(value) {
    this.validate(value);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return this.runExclusive(async () => {
      // Refuse to replace corrupt data unless read() can recover a valid backup.
      await this.read();
      const previous = await this.snapshot(this.filePath);
      if (!previous.missing) await this.atomicWrite(this.backupPath, previous.bytes, previous.mode);
      await this.atomicWrite(this.filePath, bytes);
      if (previous.missing) await this.atomicWrite(this.backupPath, bytes);
    });
  }
}

module.exports = { RecoverableJsonStore, isJsonObject };
