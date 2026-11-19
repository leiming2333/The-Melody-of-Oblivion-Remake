function createModule({ options }) {
  const { FabricApiManager } = require('../minecraft/fabric-api-manager');
  const manager = new FabricApiManager(options);
  return {
    listVersions: (_config, version, request) => manager.listVersions(version, request),
    resolveVersion: (_config, version, id, context) => manager.resolveVersion(version, id, { signal: context.signal }),
    installVersion(config, request, context) {
      Object.assign(manager, { concurrency: config.concurrency, segmentConcurrency: config.segmentConcurrency });
      return manager.installVersion(request, context.onProgress, { signal: context.signal });
    }
  };
}
module.exports = { createModule };
