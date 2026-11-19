function createModule({ options, reportChild }) {
  const { ManagedJavaRuntime } = require('../minecraft/managed-java-runtime');
  const { JavaProbeCache } = require('../minecraft/java-probe-cache');
  const { detectJava, installedJavaExecutable, javaRuntimeDetails, SUPPORTED_JAVA_MAJORS } = require('../minecraft/java-runtime');
  const { spawn } = require('node:child_process');
  const inspect = (executable, timeoutMs, operation = {}) => javaRuntimeDetails(executable, timeoutMs, {
    ...operation, spawnProcess: (...args) => reportChild(spawn(...args))
  });
  const probeJava = async (...args) => (await inspect(...args))?.majorVersion;
  let cache;
  const manager = new ManagedJavaRuntime({ ...options, probeJava, probeJavaDetails: inspect,
    extractArchive: (...args) => require('../minecraft/launch-core').extractArchive(...args) });
  return {
    async detectSystem(config, request) {
      cache ??= new JavaProbeCache(config.javaCachePath, { probe: probeJava });
      return detectJava(config.javaPath, (candidate) => cache.probe(candidate, { force: request.force === true }),
        undefined, { launcherDirectory: config.launcherDirectory });
    },
    async detect(config, request) {
      cache ??= new JavaProbeCache(config.javaCachePath, { probe: probeJava });
      const probe = (candidate) => cache.probe(candidate, { force: request.force === true });
      const results = await Promise.allSettled([
        detectJava(config.javaPath, probe, undefined, { launcherDirectory: config.launcherDirectory }),
        ...SUPPORTED_JAVA_MAJORS.map(async (majorVersion) => {
          const javaPath = await installedJavaExecutable(options.gameDirectory, majorVersion, probe);
          return javaPath ? { available: true, path: javaPath, majorVersion } : null;
        })
      ]);
      const candidates = results.filter(result => result.status === 'fulfilled' && result.value?.available).map(result => result.value);
      candidates.sort((left, right) => right.majorVersion - left.majorVersion);
      return candidates[0] ? { ...candidates[0],
        runtimes: candidates.flatMap(entry => entry.runtimes ?? [{ path: entry.path, majorVersion: entry.majorVersion }]) } : { available: false };
    },
    inspect: (_config, executable, context) => inspect(executable, undefined, { signal: context.signal }),
    resolveForGame: (_config, explicit, major, saved, context) => manager.resolveForGame(explicit, major, saved, context.onProgress, context.signal),
    ensureInstalled(config, major, context) {
      manager.segmentConcurrency = config.segmentConcurrency;
      return manager.ensureInstalled(major, context.onProgress, context.signal);
    }
  };
}
module.exports = { createModule };
