const path = require('node:path');

// Lives outside directory-scoped services, so switching directories cannot
// discard the ownership of a running or preparing game.
class GameProcessRegistry {
  constructor() { this.directories = new Map(); }

  forDirectory(directory) {
    const resolved = path.resolve(directory);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (!this.directories.has(key)) this.directories.set(key, new Map());
    return this.directories.get(key);
  }

  isBusy(directory) {
    return [...this.forDirectory(directory).values()].some((game) => game.exitCode == null);
  }
}

module.exports = { GameProcessRegistry };
