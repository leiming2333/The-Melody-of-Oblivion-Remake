function createModule({ options }) {
  const { AuthlibInjectorManager } = require('../minecraft/authlib-injector');
  const manager = new AuthlibInjectorManager(options);
  return { ensureInstalled: (_config, context) => manager.ensureInstalled(context.onProgress) };
}
module.exports = { createModule };
