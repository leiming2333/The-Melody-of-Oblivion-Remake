const fs = require('node:fs/promises');
const path = require('node:path');
const { javaMajorVersion } = require('./java-runtime');

// Only cache executable paths; bare commands can resolve to a different PATH entry.
class JavaProbeCache {
  constructor(filePath, { probe = javaMajorVersion, fileSystem = fs } = {}) {
    this.filePath = filePath;
    this.probeJava = probe;
    this.fs = fileSystem;
    this.entries = {};
    this.pending = new Map();
    this.queue = Promise.resolve();
    this.loaded = null;
  }

  load() {
    this.loaded ??= this.fs.readFile(this.filePath, 'utf8').then((text) => {
      const data = JSON.parse(text);
      if (data.version === 1 && data.entries && typeof data.entries === 'object') {
        this.entries = data.entries;
      }
    }).catch(() => {});
    return this.loaded;
  }

  async fingerprint(executable) {
    const realPath = await this.fs.realpath(executable);
    const home = path.resolve(path.dirname(realPath), '..');
    const files = [realPath, path.join(home, 'release'),
      path.join(home, 'bin', 'server', 'jvm.dll'), path.join(home, 'lib', 'server', 'libjvm.so'),
      path.join(home, 'lib', 'server', 'libjvm.dylib'), path.join(home, 'jre', 'bin', 'server', 'jvm.dll')];
    const stats = await Promise.all(files.map(async (file, index) => {
      try {
        const stat = await this.fs.stat(file);
        if (index === 0 && !stat.isFile()) throw new Error('Not a file');
        return [stat.size, stat.mtimeMs, stat.ctimeMs];
      } catch (error) {
        if (index === 0) throw error;
        return null;
      }
    }));
    return { realPath, key: JSON.stringify(stats) };
  }

  save() {
    const next = this.queue.then(async () => {
      await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.part`;
      await this.fs.writeFile(temporary, JSON.stringify({ version: 1, entries: this.entries }));
      await this.fs.rename(temporary, this.filePath);
    }).catch(() => {}); // Read-only cache directories must not block Java detection.
    this.queue = next;
    return next;
  }

  probe(executable, { force = false } = {}) {
    if (!path.isAbsolute(executable)) return this.probeJava(executable);
    const pendingKey = `${executable}:${force}`;
    if (this.pending.has(pendingKey)) return this.pending.get(pendingKey);
    const task = this.probePath(executable, force).finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, task);
    return task;
  }

  async probePath(executable, force) {
    await this.load();
    let fingerprint;
    try {
      fingerprint = await this.fingerprint(executable);
    } catch {
      return undefined;
    }
    const { realPath, key } = fingerprint;
    const cached = this.entries[realPath];
    if (!force && cached?.key === key && Number.isInteger(cached.majorVersion)) {
      return cached.majorVersion;
    }
    const majorVersion = await this.probeJava(realPath);
    if (Number.isInteger(majorVersion)) {
      const after = await this.fingerprint(executable).catch(() => null);
      if (after?.realPath === realPath && after.key === key) {
        this.entries[realPath] = { key, majorVersion };
      } else {
        delete this.entries[realPath];
      }
    } else {
      delete this.entries[realPath];
    }
    await this.save();
    return majorVersion;
  }
}

module.exports = { JavaProbeCache };
