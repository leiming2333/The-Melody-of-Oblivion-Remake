const path = require('node:path');
const { ModuleProcess } = require('../module-process');

class BackgroundSettings {
  constructor(filePath) {
    this.filePath = filePath;
    this.process = new ModuleProcess({ moduleName: 'settings',
      modulePath: path.join(__dirname, '../worker-modules/settings.js'), options: { filePath } });
  }
  prepare() { return this.process.invoke('prepare'); }
  getState() { return this.process.invoke('getState'); }
  update(patch) { return this.process.invoke('update', [patch]); }
  dispose() { return this.process.dispose(); }
}

module.exports = { BackgroundSettings };
