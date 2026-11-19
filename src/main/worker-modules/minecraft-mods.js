function createModule() {
  const { ModManager } = require('../minecraft/mod-manager');
  const manager = new ModManager();
  return { list: (_config, directory) => manager.list(directory),
    setEnabled: (_config, directory, name, enabled) => manager.setEnabled(directory, name, enabled),
    importFile: (_config, directory, filename) => manager.importFile(directory, filename) };
}
module.exports = { createModule };
