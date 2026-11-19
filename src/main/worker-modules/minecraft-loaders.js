function createModule({ options }) {
  const { MinecraftLoaderManager } = require('../minecraft/loader-manager');
  const { MinecraftSourceManager } = require('../minecraft/source-manager');
  const catalogs = new Map();
  function managerFor(config) {
    if (!catalogs.has(config.downloadSource)) {
      const sourceManager = new MinecraftSourceManager();
      sourceManager.setDownloadPreference(config.downloadSource);
      catalogs.set(config.downloadSource, new MinecraftLoaderManager({ ...options, sourceManager }));
    }
    return catalogs.get(config.downloadSource);
  }
  return {
    listLoaderVersions(config, version, type, request) {
      return managerFor(config).listLoaderVersions(version, type, request);
    },
    validateLoaderVersion(config, version, type, loader, context) {
      return managerFor(config).validateLoaderVersion(version, type, loader, context.signal);
    }
  };
}
module.exports = { createModule };
