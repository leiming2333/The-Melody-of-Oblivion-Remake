const fs = require('node:fs/promises');
const path = require('node:path');
const { readInstallationMarkerState, safePath } = require('./installation-files');
const { cleanupStaleStaging } = require('./modpack-staging');
const { PROFILE_ID_PATTERN, validateProfileId } = require('./profile-id');
const { validateVersionMetadata } = require('./metadata-schema');

async function readProfileMetadata(versionsRoot, profileId) {
  try {
    const metadataPath = safePath(versionsRoot, profileId, `${profileId}.json`);
    return validateVersionMetadata(JSON.parse(await fs.readFile(metadataPath, 'utf8')), profileId);
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError
        || error.code === 'INVALID_MINECRAFT_METADATA' || error.message === '游戏版本 ID 格式无效') return undefined;
    throw error;
  }
}

function detectLoaderType(metadata, profileId) {
  const description = [
    profileId,
    metadata?.mainClass,
    ...(Array.isArray(metadata?.libraries) ? metadata.libraries : []).map((library) => library?.name)
  ].filter(Boolean).join(' ').toLowerCase();
  if (description.includes('quilt')) return 'quilt';
  if (description.includes('fabric')) return 'fabric';
  if (description.includes('neoforge')) return 'neoforge';
  if (description.includes('forge')) return 'forge';
  return metadata?.inheritsFrom ? 'custom' : 'vanilla';
}

// 与 readVersionMetadata 的合并规则一致：子版本声明 javaVersion 时优先，
// 否则沿 inheritsFrom 继承，链上都没有则默认 Java 8。
function resolveRequiredJavaVersion(profileId, metadataById) {
  const visited = new Set();
  let currentId = profileId;
  while (typeof currentId === 'string' && PROFILE_ID_PATTERN.test(currentId) && !visited.has(currentId)) {
    visited.add(currentId);
    const metadata = metadataById.get(currentId);
    if (metadata?.javaVersion) {
      const majorVersion = Number(metadata.javaVersion.majorVersion);
      return Number.isInteger(majorVersion) && majorVersion > 0 ? majorVersion : 8;
    }
    currentId = metadata?.inheritsFrom;
  }
  return 8;
}

class MinecraftVersionManager {
  constructor({ gameDirectory, trashItem }) {
    this.gameDirectory = gameDirectory;
    this.trashItem = trashItem;
  }

  async listLocalProfiles() {
    await cleanupStaleStaging(this.gameDirectory);
    const versionsRoot = safePath(this.gameDirectory, 'versions');
    let entries;
    try {
      entries = await fs.readdir(versionsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') entries = [];
      else throw error;
    }

    const metadataById = new Map();
    const profiles = (await Promise.all(entries
      .filter((entry) => entry.isDirectory() && PROFILE_ID_PATTERN.test(entry.name))
      .map(async (entry) => {
        const metadata = await readProfileMetadata(versionsRoot, entry.name);
        metadataById.set(entry.name, metadata);
        const valid = Boolean(metadata) && (!metadata.id || metadata.id === entry.name);
        const inheritsFrom = valid && PROFILE_ID_PATTERN.test(metadata.inheritsFrom ?? '')
          ? metadata.inheritsFrom
          : undefined;
        const loaderType = detectLoaderType(metadata, entry.name);
        const marker = valid ? await readInstallationMarkerState(this.gameDirectory, entry.name)
          : { complete: false, coversInheritance: false };
        return {
          profileId: entry.name,
          displayName: inheritsFrom && loaderType !== 'custom' ? inheritsFrom : entry.name,
          type: valid ? metadata.type ?? 'unknown' : 'unknown',
          releaseTime: valid ? metadata.releaseTime ?? metadata.time : undefined,
          inheritsFrom,
          loaderType,
          valid,
          markerComplete: marker.complete,
          markerCoversInheritance: marker.coversInheritance
        };
      })));

    const byId = new Map(profiles.map((profile) => [profile.profileId, profile]));
    function isComplete(profile, visiting = new Set(), covered = false) {
      if (!profile.valid || (!covered && !profile.markerComplete) || visiting.has(profile.profileId)) return false;
      if (!profile.inheritsFrom) return true;
      const parent = byId.get(profile.inheritsFrom);
      if (!parent) return false;
      const nextVisiting = new Set(visiting);
      nextVisiting.add(profile.profileId);
      return isComplete(parent, nextVisiting, covered || profile.markerCoversInheritance);
    }

    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    const publicProfiles = profiles.map(({ markerComplete: _markerComplete,
      markerCoversInheritance: _markerCoversInheritance, ...profile }) => ({
      ...profile,
      complete: isComplete({ ...profile, markerComplete: _markerComplete, markerCoversInheritance: _markerCoversInheritance }),
      requiredJavaVersion: resolveRequiredJavaVersion(profile.profileId, metadataById)
    }));

    const profileById = new Map(publicProfiles.map((profile) => [profile.profileId, profile]));
    const instancesRoot = safePath(this.gameDirectory, 'melody-instances');
    let instanceEntries = [];
    try {
      instanceEntries = await fs.readdir(instancesRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const instances = (await Promise.all(instanceEntries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.installing-') && PROFILE_ID_PATTERN.test(entry.name))
      .map(async (entry) => {
        try {
          const metadata = JSON.parse(await fs.readFile(
            safePath(instancesRoot, entry.name, '.melody-instance.json'),
            'utf8'
          ));
          const baseProfile = profileById.get(metadata.profileId);
          const valid = metadata.schemaVersion === 1
            && metadata.instanceId === entry.name
            && Boolean(baseProfile?.valid);
          return {
            profileId: metadata.profileId,
            targetId: `instance-${entry.name}`,
            instanceId: entry.name,
            displayName: String(metadata.name ?? entry.name),
            type: 'instance',
            releaseTime: metadata.installedAt,
            loaderType: metadata.loaderType ?? baseProfile?.loaderType ?? 'custom',
            requiredJavaVersion: baseProfile?.requiredJavaVersion
              ?? resolveRequiredJavaVersion(metadata.profileId, metadataById),
            valid,
            complete: valid && baseProfile.complete,
            isInstance: true
          };
        } catch {
          return undefined;
        }
      }))).filter(Boolean);

    const allProfiles = [...instances, ...publicProfiles].sort((left, right) => {
      if (left.isInstance !== right.isInstance) {
        return Number(right.isInstance) - Number(left.isInstance);
      }
      const completeDiff = Number(right.complete) - Number(left.complete);
      if (completeDiff !== 0) return completeDiff;
      const validDiff = Number(right.valid) - Number(left.valid);
      if (validDiff !== 0) return validDiff;
      const leftName = left.displayName ?? left.profileId;
      const rightName = right.displayName ?? right.profileId;
      return collator.compare(String(leftName), String(rightName));
    });
    return { gameDirectory: this.gameDirectory, profiles: allProfiles };
  }

  async findDependents(profileId) {
    const versionsRoot = safePath(this.gameDirectory, 'versions');
    let entries = [];
    try {
      entries = await fs.readdir(versionsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const profiles = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && PROFILE_ID_PATTERN.test(entry.name))
      .map(async (entry) => {
        const metadata = await readProfileMetadata(versionsRoot, entry.name);
        return [entry.name, metadata?.inheritsFrom];
      }));
    const parents = new Map(profiles);
    const usesProfile = (referencedId) => {
      const visited = new Set();
      while (typeof referencedId === 'string' && PROFILE_ID_PATTERN.test(referencedId)) {
        if (referencedId === profileId) return true;
        if (visited.has(referencedId)) return false;
        visited.add(referencedId);
        referencedId = parents.get(referencedId);
      }
      return false;
    };
    const dependents = profiles
      .filter(([id]) => id !== profileId && usesProfile(id))
      .map(([id]) => id);

    const instancesRoot = safePath(this.gameDirectory, 'melody-instances');
    let instanceEntries = [];
    try {
      instanceEntries = await fs.readdir(instancesRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const instances = await Promise.all(instanceEntries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.installing-') && PROFILE_ID_PATTERN.test(entry.name))
      .map(async (entry) => {
        let metadata;
        try {
          metadata = JSON.parse(await fs.readFile(
            safePath(instancesRoot, entry.name, '.melody-instance.json'),
            'utf8'
          ));
        } catch (error) {
          if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
          throw error;
        }
        if (metadata?.schemaVersion !== 1 || metadata.instanceId !== entry.name
          || !usesProfile(metadata.profileId)) return undefined;
        return `整合包 ${String(metadata.name ?? entry.name)}（${entry.name}）`;
      }));
    return [...dependents, ...instances.filter(Boolean)].sort();
  }

  async deleteProfile(profileId) {
    const validatedId = validateProfileId(profileId);
    const versionsRoot = safePath(this.gameDirectory, 'versions');
    const profileRoot = safePath(versionsRoot, validatedId);
    const relativePath = path.relative(versionsRoot, profileRoot);
    if (!relativePath || relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error('游戏版本目录无效');
    }
    let stat;
    try {
      stat = await fs.lstat(profileRoot);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('该游戏版本尚未安装或已经被删除');
      throw error;
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error('游戏版本目录无效');
    }

    const dependents = await this.findDependents(validatedId);
    if (dependents.length > 0) {
      throw new Error(`该版本仍被其他实例使用，请先删除：${dependents.join('、')}`);
    }
    if (typeof this.trashItem !== 'function') {
      throw new Error('系统回收站不可用，未删除任何文件');
    }

    await this.trashItem(profileRoot);
    return {
      profileId: validatedId,
      gameDirectory: this.gameDirectory,
      recoverable: true
    };
  }
}

module.exports = {
  MinecraftVersionManager,
  PROFILE_ID_PATTERN,
  detectLoaderType,
  readProfileMetadata,
  validateProfileId
};
