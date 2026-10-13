const path = require('node:path');

// Store instances that target the same file must serialize the whole read/modify/write.
// Electron's single-instance lock protects this data from other launcher processes.
const queues = new Map();

function runFileExclusive(filePath, operation) {
  const resolved = path.resolve(filePath);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

module.exports = { runFileExclusive };
