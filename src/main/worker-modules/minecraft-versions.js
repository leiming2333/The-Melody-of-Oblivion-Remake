const fs = require('node:fs/promises');
const path = require('node:path');

function createModule({ options, callMain }) {
  const { MinecraftVersionManager } = require('../minecraft/version-manager');
  const { resolveLaunchTarget, profileGameDirectory } = require('../minecraft/launch-target');
  const { readVersionMetadata } = require('../minecraft/version-metadata');
  const manager = new MinecraftVersionManager({ ...options, trashItem: (target) => callMain('trashItem', [target]) });
  return {
    listLocalProfiles: () => manager.listLocalProfiles(),
    deleteProfile: (_config, id) => manager.deleteProfile(id),
    async getJavaRequirement(_config, targetId) {
      const instance = await resolveLaunchTarget(options.gameDirectory, String(targetId ?? ''));
      const metadata = await readVersionMetadata(options.gameDirectory, instance?.profileId ?? targetId);
      return { majorVersion: metadata.javaVersion?.majorVersion ?? 8 };
    },
    async resolveModDirectory(_config, targetId, isolate) {
      const root = options.gameDirectory;
      const instance = await resolveLaunchTarget(root, targetId);
      await readVersionMetadata(root, instance?.profileId ?? targetId);
      const directory = instance?.instanceDirectory ?? (isolate !== false ? profileGameDirectory(root, targetId) : root);
      let parent = root;
      for (const segment of path.relative(root, directory).split(path.sep).filter(Boolean)) {
        parent = path.join(parent, segment);
        try { if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error('实例目录不能是链接'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return directory;
    }
  };
}
module.exports = { createModule };
