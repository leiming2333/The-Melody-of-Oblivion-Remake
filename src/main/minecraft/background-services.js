const path = require('node:path');
const { createHash } = require('node:crypto');
const { createLazyServices } = require('../lazy-services');
const { ModuleProcess } = require('../module-process');

// Each facade owns a process, state, errors and cancellation. The main process
// coordinates trusted window/filesystem actions without running business work.
function createBackgroundMinecraftServices({ app, directory, config, shell, createLauncher, launcherRoot }) {
  const clients = new Set();
  const resolvedDirectory = path.resolve(directory);
  const directoryKey = process.platform === 'win32' ? resolvedDirectory.toLowerCase() : resolvedDirectory;
  // Directory-bound Java workers must never race on the same cache .part file.
  const cacheName = `java-minecraft-cache-${createHash('sha256').update(directoryKey).digest('hex').slice(0, 32)}.json`;
  const snapshot = () => ({ gameDirectory: directory,
    concurrency: config.downloadConcurrency ?? 32,
    segmentConcurrency: Math.min(12, Math.max(4, Math.floor((config.downloadConcurrency ?? 32) / 2))),
    javaPath: config.javaPath, downloadSource: config.downloadSource ?? 'auto',
    launcherDirectory: launcherRoot ?? app.getAppPath?.(),
    javaCachePath: path.join(app.getPath?.('userData') ?? directory, cacheName) });
  const processFor = (module, options = {}) => {
    const client = new ModuleProcess({ moduleName: `minecraft-${module}`,
      modulePath: path.join(__dirname, '../worker-modules', `minecraft-${module}.js`),
      options: { gameDirectory: directory, ...options },
      handlers: { trashItem: (target) => shell.trashItem(target),
        prepareFindJava: (id, ...args) => preparationOperations.get(id).findJava(...args),
        prepareInspectJava: (id, ...args) => preparationOperations.get(id).inspectJava(...args),
        prepareVerifyFiles: (id, profile) => {
          const active = preparationOperations.get(id);
          return active.verifyFiles(profile, active.onVerifyProgress);
        },
        validateLoaderVersion: (version, type, loader, operationId) => {
          const active = loaderOperations.get(operationId);
          if (!active) throw new Error('整合包加载器任务已结束');
          return services.loaderManager.validateWithConfig(version, type, loader, active.config, active.signal);
        },
        installLoader: (request, operationId) => {
          const active = loaderOperations.get(operationId);
          if (!active) throw new Error('整合包加载器任务已结束');
          const { LoaderInstallProcess } = require('./loader-install-process');
          return new LoaderInstallProcess(active.config).installLoader(request,
            (progress) => active.onProgress?.({ ...progress, phase: 'installing-base' }), { signal: active.signal });
        } }
    });
    clients.add(client);
    return client;
  };
  const loaderOperations = new Map();
  const preparationOperations = new Map();
  const facade = (module) => {
    const client = processFor(module);
    const target = {};
    target.invoke = (method, args, operation = {}, configuration = snapshot()) => client.invoke(method, [configuration, ...args], operation);
    return target;
  };
  const services = createLazyServices({
    downloader: () => {
      const f = facade('download');
      return { listVersions: (options = {}) => f.invoke('listVersions', [options]),
        installVersion: (id, onProgress, { signal } = {}) => f.invoke('installVersion', [id], { signal, onProgress }),
        verifyVersion: (id, onProgress) => f.invoke('verifyVersion', [id], { onProgress }),
        repairVersion: (id, onProgress, { signal } = {}) => f.invoke('repairVersion', [id], { signal, onProgress }) };
    },
    loaderManager: () => {
      const f = facade('loaders');
      return { listLoaderVersions: (gameVersion, type, options = {}) => f.invoke('listLoaderVersions', [gameVersion, type, options]),
        validateLoaderVersion: (gameVersion, type, version, signal) => f.invoke('validateLoaderVersion', [gameVersion, type, version], { signal }),
        validateWithConfig: (gameVersion, type, version, config, signal) => f.invoke('validateLoaderVersion', [gameVersion, type, version], { signal }, config) };
    },
    loaderInstaller: () => {
      const { LoaderInstallProcess } = require('./loader-install-process');
      return { installLoader: (request, onProgress, options) => new LoaderInstallProcess(snapshot()).installLoader(request, onProgress, options) };
    },
    versionManager: () => {
      const f = facade('versions');
      return { listLocalProfiles: () => f.invoke('listLocalProfiles', []),
        deleteProfile: (id) => f.invoke('deleteProfile', [id]),
        getJavaRequirement: (id) => f.invoke('getJavaRequirement', [id]),
        resolveModDirectory: (id, isolate) => f.invoke('resolveModDirectory', [id, isolate]) };
    },
    modManager: () => {
      const f = facade('mods');
      return { list: (directory) => f.invoke('list', [directory]),
        setEnabled: (...args) => f.invoke('setEnabled', args), importFile: (...args) => f.invoke('importFile', args) };
    },
    javaRuntime: () => {
      const f = facade('java');
      return { detect: (options = {}) => f.invoke('detect', [options]),
        inspect: (executable) => f.invoke('inspect', [executable]),
        resolveForGame: (explicit, major, saved = [], onProgress, signal) => f.invoke('resolveForGame', [explicit, major, saved], { signal, onProgress }),
        ensureInstalled: (major, onProgress, signal) => f.invoke('ensureInstalled', [major], { signal, onProgress }) };
    },
    fabricApiManager: () => {
      const f = facade('fabric-api');
      return { listVersions: (version, options = {}) => f.invoke('listVersions', [version, options]),
        resolveVersion: (version, id, { signal } = {}) => f.invoke('resolveVersion', [version, id], { signal }),
        installVersion: (request, onProgress, { signal } = {}) => f.invoke('installVersion', [request], { signal, onProgress }) };
    },
    authlibInjector: () => {
      const f = facade('authlib');
      return { ensureInstalled: (onProgress) => f.invoke('ensureInstalled', [], { onProgress }) };
    },
    modpackManager: () => {
      const f = facade('modpacks');
      const operation = async (method, args, { signal, onProgress } = {}) => {
        const operationId = require('node:crypto').randomUUID();
        loaderOperations.set(operationId, { signal, onProgress, config: snapshot() });
        try { return await f.invoke(method, [operationId, ...args], { signal, onProgress }); }
        finally { loaderOperations.delete(operationId); }
      };
      return { inspect: (filename, { signal } = {}) => operation('inspect', [filename], { signal }),
        claimRecoverySession: (owner) => operation('claimRecoverySession', [owner]),
        install: (filename, onProgress, options = {}) => operation('install', [filename, { ownerId: options.ownerId, installOptionalFiles: options.installOptionalFiles }], { signal: options.signal, onProgress }),
        resume: (id, onProgress, options = {}) => operation('resume', [id, { ownerId: options.ownerId }], { signal: options.signal, onProgress }),
        getRecoveryState: (id, options = {}) => operation('getRecoveryState', [id, options]),
        importMissingFile: (id, file, options = {}) => operation('importMissingFile', [id, file, { ownerId: options.ownerId }], { signal: options.signal }),
        discardSession: (id, options = {}) => operation('discardSession', [id, options]),
        discardOwnerSessions: (owner) => operation('discardOwnerSessions', [owner]),
        releaseOwnerSessions: (owner) => { void operation('releaseOwnerSessions', [owner]).catch(() => {}); }
      };
    },
    launchPreparation: () => {
      const f = facade('launch-preparation');
      return { prepareLaunch: async (options) => {
        const { findJava, inspectJava, verifyFiles, onVerifyProgress, ...request } = options;
        const id = require('node:crypto').randomUUID();
        preparationOperations.set(id, { findJava, inspectJava, verifyFiles, onVerifyProgress });
        try { return await f.invoke('prepareLaunch', [id, request, Boolean(inspectJava)]); }
        finally { preparationOperations.delete(id); }
      } };
    },
    launcher: (registry) => createLauncher(registry, {
      prepareLaunchImpl: registry.launchPreparation.prepareLaunch,
      createLog: require('./background-game-log').createBackgroundGameLog
    })
  });
  const dispose = async () => { await Promise.all([...clients].map((client) => client.dispose())); };
  app.once?.('before-quit', () => { void dispose(); });
  return new Proxy(services, { get: (target, name) => name === 'dispose' ? dispose : target[name] });
}

function createJavaBackgroundService({ cachePath, launcherDirectory } = {}) {
  const client = new ModuleProcess({ moduleName: 'java-settings',
    modulePath: path.join(__dirname, '../worker-modules/minecraft-java.js'), options: {} });
  return {
    detectJava: (javaPath, options = {}) => client.invoke('detectSystem', [{ javaPath, javaCachePath: cachePath, launcherDirectory }, options]),
    javaMajorVersion: async (javaPath) => (await client.invoke('inspect', [{}, javaPath]))?.majorVersion,
    dispose: () => client.dispose()
  };
}

function createFabricApiCatalog() {
  const client = new ModuleProcess({ moduleName: 'minecraft-fabric-api-catalog',
    modulePath: path.join(__dirname, '../worker-modules/minecraft-fabric-api.js'), options: {} });
  return { listVersions: (gameVersion, options = {}) => client.invoke('listVersions', [{}, gameVersion, options]),
    dispose: () => client.dispose() };
}

module.exports = { createBackgroundMinecraftServices, createJavaBackgroundService, createFabricApiCatalog };
