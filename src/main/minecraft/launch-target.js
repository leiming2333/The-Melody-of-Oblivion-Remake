const fs = require('node:fs/promises');
const path = require('node:path');
const { safePath } = require('./installation-files');
const INSTANCE_ID_PATTERN = /^[0-9A-Za-z._-]{1,100}$/;

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`整合包清单已损坏：${path.basename(filePath)}`);
    throw error;
  }
}

async function resolveLaunchTarget(gameDirectory, targetId) {
    const value = String(targetId ?? '');
    if (!value.startsWith('instance-')) return undefined;
    const instanceId = value.slice('instance-'.length);
    if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new Error('整合包实例 ID 无效');
    const instanceDirectory = safePath(gameDirectory, 'melody-instances', instanceId);
    const metadata = await readJson(safePath(instanceDirectory, '.melody-instance.json'));
    if (!metadata || metadata.schemaVersion !== 1 || metadata.instanceId !== instanceId) {
      throw new Error('整合包实例不存在或配置已损坏');
    }
    return {
      instanceDirectory,
      instanceId,
      name: metadata.name,
      profileId: metadata.profileId,
      targetId: value
    };
  }
// Hash IDs so case-insensitive filesystems also keep distinct profiles apart.
function profileGameDirectory(gameDirectory, profileId) {
  if (typeof profileId !== 'string' || !profileId || /[\\/\0]/.test(profileId) || profileId === '.' || profileId === '..') {
    throw new Error('游戏版本 ID 无效');
  }
  const id = require('node:crypto').createHash('sha256').update(profileId).digest('hex');
  return safePath(gameDirectory, 'melody-profiles', id);
}
module.exports = { resolveLaunchTarget, profileGameDirectory };
