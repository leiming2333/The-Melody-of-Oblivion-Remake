const fs = require('node:fs/promises');
const { safePath } = require('./installation-files');
const { validateProfileId } = require('./version-manager');

function libraryKey(library) {
  const parts = String(library?.name ?? '').split(':');
  return parts.length >= 2
    ? `${parts[0]}:${parts[1]}:${parts[3] ?? ''}`
    : String(library?.name ?? JSON.stringify(library));
}

function mergeLibraries(parentLibraries = [], childLibraries = []) {
  const merged = [];
  const positions = new Map();
  for (const library of [...parentLibraries, ...childLibraries]) {
    const key = libraryKey(library);
    if (positions.has(key)) merged[positions.get(key)] = library;
    else {
      positions.set(key, merged.length);
      merged.push(library);
    }
  }
  return merged;
}

function mergeMetadata(parent, child) {
  if (!parent) {
    return {
      ...child,
      arguments: {
        game: [...(child.arguments?.game ?? [])],
        jvm: [...(child.arguments?.jvm ?? [])]
      },
      libraries: [...(child.libraries ?? [])],
      minecraftArguments: child.minecraftArguments ?? '',
      clientJarId: child.jar ?? child.id
    };
  }
  const legacyArguments = child.minecraftArguments ?? parent.minecraftArguments;
  return {
    ...parent,
    ...child,
    arguments: {
      game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
      jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])]
    },
    libraries: mergeLibraries(parent.libraries, child.libraries),
    minecraftArguments: legacyArguments,
    clientJarId: child.jar ?? parent.clientJarId
  };
}

async function readVersionMetadata(gameDirectory, profileId, visited = new Set()) {
  const validatedId = validateProfileId(profileId);
  if (visited.has(validatedId)) throw new Error('游戏版本配置存在循环继承');
  visited.add(validatedId);

  const metadataPath = safePath(
    gameDirectory,
    'versions',
    validatedId,
    `${validatedId}.json`
  );
  let child;
  try {
    child = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`找不到游戏版本 ${validatedId} 的启动配置`);
    if (error instanceof SyntaxError) throw new Error(`游戏版本 ${validatedId} 的启动配置已损坏`);
    throw error;
  }
  if (child.id && child.id !== validatedId) {
    throw new Error(`游戏版本目录与启动配置 ID 不一致：${validatedId}`);
  }

  const parent = child.inheritsFrom
    ? await readVersionMetadata(gameDirectory, child.inheritsFrom, visited)
    : undefined;
  visited.delete(validatedId);
  return mergeMetadata(parent, { ...child, id: validatedId });
}


module.exports = { mergeLibraries, mergeMetadata, readVersionMetadata };
