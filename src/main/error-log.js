const fs = require('node:fs/promises');
const path = require('node:path');

function redactError(message) {
  return String(message).slice(0, 8000)
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:access[_-]?token|refresh[_-]?token|microsoftRefreshToken|clientToken|password|device_code|user_code)["']?\s*(?:[:=]\s*|\s+))(?:("[^"]*")|('[^']*')|([^\s,;]+))/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
}

class ErrorLog {
  constructor(directory) {
    this.filePath = path.join(directory, 'logs', 'errors-latest.json');
    this.entries = [];
    this.queue = Promise.resolve();
  }

  record(message) {
    this.entries.push({ at: new Date().toISOString(), message: redactError(message) });
    this.entries = this.entries.slice(-50);
    const report = JSON.stringify(this.entries, null, 2);
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, report);
    }).catch(() => {});
    return this.queue;
  }
}

module.exports = { ErrorLog, redactError };
