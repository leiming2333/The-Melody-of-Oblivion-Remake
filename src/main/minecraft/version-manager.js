const fs = require('node:fs/promises');
const { hasInstallationMarker, safePath } = require('./downloader');

const PROFILE_ID_PATTERN = /^[0-9A-Za-z._+-]{1,120}$/;

function validateProfileId(profileId) {
  const normalized = String(profileId ?? '');
  if (!PROFILE_ID_PATTERN.test(normalized)) {
    throw new Error('游戏版本 ID 格式无效');
  }
  return normalized;
}

async function readProfileMetadata(versionsRoot, profileId) {
  try {
    const metadataPath = safePath(versionsRoot, profileId, `${profileId}.json`);
    return JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function detectLoaderType(metadata, profileId) {
  const description = [
    profileId,
    metadata?.mainClass,
    ...(metadata?.libraries ?? []).map((library) => library?.name)
  ].filter(Boolean).join(' ').toLowerCase();
  if (description.includes('fabric')) return 'fabric';
  if (description.includes('neoforge')) return 'neoforge';
  if (description.includes('forge')) return 'forge';
  return metadata?.inheritsFrom ? 'custom' : 'vanilla';
}

class MinecraftVersionManager {
  constructor({ gameDirectory, trashItem }) {
    this.gameDirectory = gameDirectory;
    this.trashItem = trashItem;
  }

  async listLocalProfiles() {
    const versionsRoot = safePath(this.gameDirectory, 'versions');
    let entries;
    try {
      entries = await fs.readdir(versionsRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') entries = [];
      else throw error;
    }

    const profiles = (await Promise.all(entries
      .filter((entry) => entry.isDirectory() && PROFILE_ID_PATTERN.test(entry.name))
      .map(async (entry) => {
        const metadata = await readProfileMetadata(versionsRoot, entry.name);
        const valid = Boolean(metadata) && (!metadata.id || metadata.id === entry.name);
        const inheritsFrom = valid && PROFILE_ID_PATTERN.test(metadata.inheritsFrom ?? '')
          ? metadata.inheritsFrom
          : undefined;
        const loaderType = detectLoaderType(metadata, entry.name);
        return {
          profileId: entry.name,
          displayName: inheritsFrom && loaderType !== 'custom' ? inheritsFrom : entry.name,
          type: valid ? metadata.type ?? 'unknown' : 'unknown',
          releaseTime: valid ? metadata.releaseTime ?? metadata.time : undefined,
          inheritsFrom,
          loaderType,
          valid,
          markerComplete: valid
            ? await hasInstallationMarker(this.gameDirectory, entry.name)
            : false
        };
      })));

    const byId = new Map(profiles.map((profile) => [profile.profileId, profile]));
    function isComplete(profile, visiting = new Set()) {
      if (!profile.markerComplete || visiting.has(profile.profileId)) return false;
      if (!profile.inheritsFrom) return true;
      const parent = byId.get(profile.inheritsFrom);
      if (!parent) return false;
      const nextVisiting = new Set(visiting);
      nextVisiting.add(profile.profileId);
      return isComplete(parent, nextVisiting);
    }

    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    const publicProfiles = profiles.map(({ markerComplete: _markerComplete, ...profile }) => ({
      ...profile,
      complete: isComplete({ ...profile, markerComplete: _markerComplete })
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
      .filter((entry) => entry.isDirectory() && PROFILE_ID_PATTERN.test(entry.name))
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
      if (error.code === 'ENOENT') return [];
      throw error;
    }

    const dependents = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name !== profileId)
      .map(async (entry) => {
        if (!PROFILE_ID_PATTERN.test(entry.name)) return undefined;
        const metadata = await readProfileMetadata(versionsRoot, entry.name);
        return metadata?.inheritsFrom === profileId ? entry.name : undefined;
      }));
    return dependents.filter(Boolean).sort();
  }

  async deleteProfile(profileId) {
    const validatedId = validateProfileId(profileId);
    const versionsRoot = safePath(this.gameDirectory, 'versions');
    const profileRoot = safePath(versionsRoot, validatedId);
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
