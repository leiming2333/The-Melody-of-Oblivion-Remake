function createModule({ options }) {
  const { MinecraftDownloader } = require('../minecraft/downloader');
  const { MinecraftSourceManager } = require('../minecraft/source-manager');
  const catalogs = new Map();
  function managerFor(config, cached = false) {
    if (cached && catalogs.has(config.downloadSource)) return catalogs.get(config.downloadSource);
    const sourceManager = new MinecraftSourceManager();
    sourceManager.setDownloadPreference(config.downloadSource);
    const manager = new MinecraftDownloader({ ...options, ...config, sourceManager });
    if (cached) catalogs.set(config.downloadSource, manager);
    return manager;
  }
  return {
    listVersions(config, request) { return managerFor(config, true).listVersions(request); },
    installVersion(config, id, context) { return managerFor(config).installVersion(id, context.onProgress, { signal: context.signal }); },
    verifyVersion(config, id, context) { return managerFor(config).verifyVersion(id, context.onProgress); },
    repairVersion(config, id, context) { return managerFor(config).repairVersion(id, context.onProgress, { signal: context.signal }); }
  };
}
module.exports = { createModule };
