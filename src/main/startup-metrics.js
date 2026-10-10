const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

class StartupMetrics {
  constructor() {
    this.startedAt = new Date().toISOString();
    this.start = performance.now();
    this.stages = [];
    this.filePath = null;
    this.queue = Promise.resolve();
  }

  mark(stage) {
    if (this.stages.some((entry) => entry.stage === stage)) return;
    this.stages.push({ stage, elapsedMs: Math.round(performance.now() - this.start),
      processUptimeMs: Math.round(process.uptime() * 1000) });
    if (!this.filePath) return;
    const report = JSON.stringify({ startedAt: this.startedAt, stages: this.stages }, null, 2);
    this.queue = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, report);
    }).catch(() => {});
  }

  attach(directory) {
    this.filePath = path.join(directory, 'logs', 'startup-latest.json');
  }

  print(logger = console) {
    let previous = 0;
    logger.table(this.stages.map(({ stage, elapsedMs }) => {
      const sincePreviousMs = elapsedMs - previous;
      previous = elapsedMs;
      return { stage, elapsedMs, sincePreviousMs };
    }));
  }
}

module.exports = { StartupMetrics };
