const { AsyncLocalStorage } = require('node:async_hooks');

function createModule({ options, callMain }) {
  const { ModpackManager } = require('../minecraft/modpack-manager');
  const operation = new AsyncLocalStorage();
  const manager = new ModpackManager(options);
  manager.loaderManager = {
    validateLoaderVersion: (version, type, loader) => callMain('validateLoaderVersion', [version, type, loader, operation.getStore()]),
    installLoader: (request) => callMain('installLoader', [request, operation.getStore()])
  };
  const invoke = (method, config, id, args, context) => operation.run(id, () => {
    if (['install', 'resume'].includes(method)) {
      Object.assign(manager, { concurrency: config.concurrency, segmentConcurrency: config.segmentConcurrency });
    }
    const opts = { signal: context.signal };
    if (method === 'inspect') return manager.inspect(args[0], opts);
    if (['install', 'resume'].includes(method)) return manager[method](args[0], context.onProgress, { ...args[1], ...opts });
    if (method === 'importMissingFile') return manager.importMissingFile(args[0], args[1], { ...args[2], ...opts });
    return manager[method](...args);
  });
  return Object.fromEntries(['inspect', 'claimRecoverySession', 'install', 'resume', 'getRecoveryState',
    'importMissingFile', 'discardSession', 'discardOwnerSessions', 'releaseOwnerSessions'].map(method => [method,
    (config, id, ...args) => invoke(method, config, id, args.slice(0, -1), args.at(-1))]));
}
module.exports = { createModule };
