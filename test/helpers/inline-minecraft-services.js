const { createLazyServices } = require('../../src/main/lazy-services');

// Unit fixtures inject local implementations so prototype mocks remain scoped
// to the fixture. Production always uses the process-backed service registry.
function createInlineMinecraftServices({ app, directory, config, shell, getJavaProbeCache, createLauncher, implementations = {} }) {
  const transferOptions = () => ({ gameDirectory: directory, concurrency: config.downloadConcurrency ?? 32,
    segmentConcurrency: Math.min(12, Math.max(4, Math.floor((config.downloadConcurrency ?? 32) / 2))) });
  return createLazyServices({
    sourceManager: () => {
      const { MinecraftSourceManager } = require('../../src/main/minecraft/source-manager');
      const manager = new MinecraftSourceManager();
      manager.setDownloadPreference(config.downloadSource ?? 'auto');
      return manager;
    },
    downloader: registry => new (require('../../src/main/minecraft/downloader').MinecraftDownloader)({ ...transferOptions(), sourceManager: registry.sourceManager }),
    loaderManager: registry => {
      const manager = new (require('../../src/main/minecraft/loader-manager').MinecraftLoaderManager)({ ...transferOptions(),
        sourceManager: registry.sourceManager, downloader: registry.downloader });
      manager.javaPath = config.javaPath;
      return manager;
    },
    loaderInstaller: () => new (require('../../src/main/minecraft/loader-install-process').LoaderInstallProcess)({ ...transferOptions(),
      downloadSource: config.downloadSource, javaPath: config.javaPath }),
    fabricApiManager: () => new (implementations.FabricApiManager ?? require('../../src/main/minecraft/fabric-api-manager').FabricApiManager)(transferOptions()),
    versionManager: () => {
      const manager = new (require('../../src/main/minecraft/version-manager').MinecraftVersionManager)({ gameDirectory: directory, trashItem: target => shell.trashItem(target) });
      const methods = require('../../src/main/worker-modules/minecraft-versions').createModule({ options: { gameDirectory: directory },
        callMain: (_method, [target]) => shell.trashItem(target) });
      manager.getJavaRequirement = id => methods.getJavaRequirement({}, id);
      manager.resolveModDirectory = (id, isolate) => methods.resolveModDirectory({}, id, isolate);
      return manager;
    },
    modManager: () => new (require('../../src/main/minecraft/mod-manager').ModManager)(),
    modpackManager: registry => {
      const manager = new (require('../../src/main/minecraft/modpack-manager').ModpackManager)(transferOptions());
      manager.loaderManager = { validateLoaderVersion: (...args) => registry.loaderManager.validateLoaderVersion(...args),
        installLoader: (...args) => registry.loaderInstaller.installLoader(...args) };
      return manager;
    },
    javaRuntime: () => {
      const java = require('../../src/main/minecraft/java-runtime');
      const javaProbeCache = getJavaProbeCache?.();
      const manager = new (require('../../src/main/minecraft/managed-java-runtime').ManagedJavaRuntime)({ gameDirectory: directory,
        extractArchive: (...args) => require('../../src/main/minecraft/launch-core').extractArchive(...args),
        probeJava: javaProbeCache ? candidate => javaProbeCache.probe(candidate) : java.javaMajorVersion });
      manager.detect = async (options = {}) => {
        const probe = javaProbeCache ? candidate => javaProbeCache.probe(candidate, { force: options.force === true }) : java.javaMajorVersion;
        const results = await Promise.allSettled([
          java.detectJava(config.javaPath, probe, undefined, { launcherDirectory: app.getAppPath?.() }),
          ...java.SUPPORTED_JAVA_MAJORS.map(async majorVersion => {
            const javaPath = await java.installedJavaExecutable(directory, majorVersion, probe);
            return javaPath ? { available: true, path: javaPath, majorVersion } : null;
          })
        ]);
        const candidates = results.filter(result => result.status === 'fulfilled' && result.value?.available).map(result => result.value);
        candidates.sort((a, b) => b.majorVersion - a.majorVersion);
        return candidates[0] ? { ...candidates[0], runtimes: candidates.flatMap(entry => entry.runtimes ?? [{ path: entry.path, majorVersion: entry.majorVersion }]) } : { available: false };
      };
      return manager;
    },
    launcher: registry => createLauncher(registry),
    authlibInjector: () => new (require('../../src/main/minecraft/authlib-injector').AuthlibInjectorManager)({ gameDirectory: directory })
  });
}

module.exports = { createInlineMinecraftServices };
