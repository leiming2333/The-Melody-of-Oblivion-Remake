const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const {
  mavenPathFromName,
  safePath
} = require('./downloader');
const { findJavaExecutable } = require('./java-runtime');
const { ManagedJavaRuntime } = require('./managed-java-runtime');
const { validateProfileId } = require('./version-manager');
const { offlineUuidForSkinModel } = require('../accounts/account-store');

const inflateRaw = promisify(zlib.inflateRaw);
const LAUNCHER_NAME = 'melody-of-oblivion';
const LAUNCHER_VERSION = '0.1.0';
const DEFAULT_FEATURES = Object.freeze({
  has_custom_resolution: false,
  has_quick_plays_support: false,
  is_demo_user: false,
  is_quick_play_multiplayer: false,
  is_quick_play_realms: false,
  is_quick_play_singleplayer: false
});

function minecraftPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function minecraftArchitecture() {
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'arm64') return 'arm64';
  return 'x64';
}

function ruleMatches(rule, features = DEFAULT_FEATURES) {
  if (rule?.os) {
    if (rule.os.name && rule.os.name !== minecraftPlatform()) return false;
    if (rule.os.arch && rule.os.arch !== minecraftArchitecture()) return false;
    if (rule.os.version) {
      try {
        if (!new RegExp(rule.os.version).test(os.release())) return false;
      } catch {
        return false;
      }
    }
  }

  if (rule?.features) {
    return Object.entries(rule.features).every(
      ([name, required]) => Boolean(features[name]) === Boolean(required)
    );
  }
  return true;
}

function rulesAllow(rules, features = DEFAULT_FEATURES) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (ruleMatches(rule, features)) allowed = rule.action === 'allow';
  }
  return allowed;
}

function expandArgumentEntries(entries, features = DEFAULT_FEATURES) {
  const result = [];
  for (const entry of entries ?? []) {
    if (typeof entry === 'string') {
      result.push(entry);
      continue;
    }
    if (!entry || !rulesAllow(entry.rules, features)) continue;
    if (Array.isArray(entry.value)) result.push(...entry.value.map(String));
    else if (entry.value !== undefined) result.push(String(entry.value));
  }
  return result;
}

function splitLegacyArguments(value) {
  const result = [];
  let current = '';
  let quote = '';
  let escaping = false;
  for (const character of String(value ?? '')) {
    if (escaping) {
      current += character;
      escaping = false;
    } else if (character === '\\' && quote) {
      escaping = true;
    } else if (quote) {
      if (character === quote) quote = '';
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaping) current += '\\';
  if (current) result.push(current);
  return result;
}

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
  const legacyArguments = [parent.minecraftArguments, child.minecraftArguments]
    .filter(Boolean)
    .join(' ');
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

function libraryArtifactPath(gameDirectory, library) {
  const relativePath = library.downloads?.artifact?.path ?? mavenPathFromName(library.name);
  return relativePath ? safePath(gameDirectory, 'libraries', relativePath) : undefined;
}

function nativeClassifier(library) {
  const template = library.natives?.[minecraftPlatform()];
  if (!template) return undefined;
  return template.replace('${arch}', process.arch === 'ia32' ? '32' : '64');
}

function nativeArtifactPath(gameDirectory, library) {
  const classifierName = nativeClassifier(library);
  if (!classifierName) return undefined;
  const classifier = library.downloads?.classifiers?.[classifierName];
  const relativePath = classifier?.path ?? mavenPathFromName(`${library.name}:${classifierName}`);
  return relativePath ? safePath(gameDirectory, 'libraries', relativePath) : undefined;
}

function libraryIsAllowed(library, features = DEFAULT_FEATURES) {
  return rulesAllow(library.rules, features);
}

async function assertFilesExist(files, label) {
  const missing = [];
  for (const filePath of files) {
    try {
      await fs.access(filePath);
    } catch {
      missing.push(filePath);
    }
  }
  if (missing.length > 0) {
    const details = missing.slice(0, 4).map((filePath) => path.basename(filePath)).join('、');
    throw new Error(`${label}缺失：${details}${missing.length > 4 ? ` 等 ${missing.length} 个文件` : ''}`);
  }
}

function normalizeZipPath(entryName) {
  const normalized = String(entryName).replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('原生库中包含不安全的文件路径');
  }
  return segments;
}

async function extractNativeArchive(archivePath, destination, excludes = []) {
  const archive = await fs.readFile(archivePath);
  const minimumOffset = Math.max(0, archive.length - 65557);
  let endOffset = -1;
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error(`原生库压缩包无效：${path.basename(archivePath)}`);

  const entryCount = archive.readUInt16LE(endOffset + 10);
  let centralOffset = archive.readUInt32LE(endOffset + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error(`原生库目录损坏：${path.basename(archivePath)}`);
    }
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const entryName = archive.subarray(
      centralOffset + 46,
      centralOffset + 46 + nameLength
    ).toString('utf8');
    centralOffset += 46 + nameLength + extraLength + commentLength;

    const slashName = entryName.replaceAll('\\', '/');
    if (slashName.endsWith('/') || excludes.some((prefix) => slashName.startsWith(prefix))) continue;
    const segments = normalizeZipPath(slashName);
    if (segments.length === 0) continue;
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`原生库文件头损坏：${path.basename(archivePath)}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = await inflateRaw(compressed);
    else throw new Error(`原生库使用了不支持的压缩格式：${method}`);

    const destinationPath = safePath(destination, ...segments);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, content);
  }
}

function replaceVariables(argument, variables) {
  return String(argument).replace(/\$\{([^}]+)\}/g, (match, name) => (
    Object.hasOwn(variables, name) ? String(variables[name]) : match
  ));
}

function normalizeAccount(account) {
  if (!account || !/^[A-Za-z0-9_]{3,16}$/.test(account.name ?? '')) {
    throw new Error('请先添加并选择一个可用的游戏账户');
  }
  const accountUuid = account.type === 'offline'
    ? offlineUuidForSkinModel(account.uuid, account.skinModel)
    : account.uuid;
  const uuid = String(accountUuid ?? '').replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(uuid)) throw new Error('当前游戏账户 UUID 无效');
  return {
    name: account.name,
    uuid,
    skinModel: account.skinModel === 'alex' ? 'alex' : 'steve',
    accessToken: account.accessToken || '0',
    userType: account.type === 'microsoft' ? 'msa' : 'legacy',
    xuid: account.xuid || '',
    clientId: account.clientId || ''
  };
}

function launchVariables({
  account,
  assetIndexId,
  classpath,
  gameDirectory,
  instanceDirectory,
  metadata,
  nativesDirectory,
  profileId
}) {
  const normalizedAccount = normalizeAccount(account);
  const assetsRoot = safePath(gameDirectory, 'assets');
  const legacyAssets = safePath(assetsRoot, 'virtual', assetIndexId || 'legacy');
  return {
    arch: process.arch === 'ia32' ? '32' : '64',
    assets_index_name: assetIndexId || '',
    assets_root: assetsRoot,
    auth_access_token: normalizedAccount.accessToken,
    auth_player_name: normalizedAccount.name,
    auth_session: `token:${normalizedAccount.accessToken}:${normalizedAccount.uuid}`,
    auth_uuid: normalizedAccount.uuid,
    auth_xuid: normalizedAccount.xuid,
    classpath,
    classpath_separator: path.delimiter,
    clientid: normalizedAccount.clientId,
    game_assets: legacyAssets,
    game_directory: instanceDirectory ?? gameDirectory,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    library_directory: safePath(gameDirectory, 'libraries'),
    natives_directory: nativesDirectory,
    primary_jar: safePath(gameDirectory, 'versions', metadata.clientJarId, `${metadata.clientJarId}.jar`),
    profile_name: profileId,
    profile_properties: '{}',
    resolution_height: 480,
    resolution_width: 854,
    user_properties: '{}',
    user_type: normalizedAccount.userType,
    version_name: profileId,
    version_type: metadata.type || 'release'
  };
}

async function prepareLaunch({
  gameDirectory,
  profileId,
  account,
  memoryMb = 4096,
  javaPath,
  instanceDirectory,
  authlibInjector,
  findJava = findJavaExecutable
}) {
  const validatedId = validateProfileId(profileId);
  const metadata = await readVersionMetadata(gameDirectory, validatedId);
  if (!metadata.mainClass) throw new Error(`游戏版本 ${validatedId} 缺少启动主类`);

  const allowedLibraries = (metadata.libraries ?? []).filter((library) => libraryIsAllowed(library));
  const classpathEntries = allowedLibraries
    .map((library) => libraryArtifactPath(gameDirectory, library))
    .filter(Boolean);
  const clientJar = safePath(
    gameDirectory,
    'versions',
    metadata.clientJarId,
    `${metadata.clientJarId}.jar`
  );
  classpathEntries.push(clientJar);
  await assertFilesExist(classpathEntries, '游戏依赖文件');

  const nativeLibraries = allowedLibraries
    .map((library) => ({
      archivePath: nativeArtifactPath(gameDirectory, library),
      excludes: library.extract?.exclude ?? []
    }))
    .filter((entry) => entry.archivePath);
  await assertFilesExist(nativeLibraries.map((entry) => entry.archivePath), '游戏原生库');

  const launchId = `${validatedId}-${process.pid}-${Date.now()}`;
  const nativesDirectory = safePath(gameDirectory, 'launcher-cache', 'natives', launchId);
  await fs.mkdir(nativesDirectory, { recursive: true });
  try {
    for (const nativeLibrary of nativeLibraries) {
      await extractNativeArchive(
        nativeLibrary.archivePath,
        nativesDirectory,
        nativeLibrary.excludes
      );
    }

    const classpath = [...new Set(classpathEntries)].join(path.delimiter);
    const assetIndexId = metadata.assetIndex?.id ?? metadata.assets ?? '';
    const variables = launchVariables({
      account,
      assetIndexId,
      classpath,
      gameDirectory,
      instanceDirectory,
      metadata,
      nativesDirectory,
      profileId: validatedId
    });
    const features = DEFAULT_FEATURES;
    let jvmArguments = expandArgumentEntries(metadata.arguments?.jvm, features);
    if (jvmArguments.length === 0) {
      jvmArguments = [
        '-Djava.library.path=${natives_directory}',
        '-cp',
        '${classpath}'
      ];
    }
    const maximumMemory = Math.min(16384, Math.max(2048, Number(memoryMb) || 4096));
    jvmArguments.unshift(`-Xmx${Math.round(maximumMemory)}M`, '-Xms512M');
    if (account?.type === 'yggdrasil') {
      const injectorPath = path.resolve(String(authlibInjector?.path ?? ''));
      if (!authlibInjector?.path || !path.isAbsolute(injectorPath)) {
        throw new Error('LittleSkin 登录组件路径无效');
      }
      await fs.access(injectorPath);
      const authServer = authlibInjector.server === 'littleskin.cn'
        ? authlibInjector.server
        : 'littleskin.cn';
      jvmArguments.unshift(`-javaagent:${injectorPath}=${authServer}`);
    }
    const logging = metadata.logging?.client;
    if (logging?.argument && logging.file?.id) {
      jvmArguments.push(logging.argument.replace(
        '${path}',
        safePath(gameDirectory, 'assets', 'log_configs', logging.file.id)
      ));
    }
    jvmArguments = jvmArguments.map((argument) => replaceVariables(argument, variables));

    const modernGameArguments = expandArgumentEntries(metadata.arguments?.game, features);
    const gameArguments = (modernGameArguments.length > 0
      ? modernGameArguments
      : splitLegacyArguments(metadata.minecraftArguments)
    ).map((argument) => replaceVariables(argument, variables));
    const javaExecutable = await findJava(javaPath, metadata.javaVersion?.majorVersion);
    const workingDirectory = instanceDirectory
      ? path.resolve(instanceDirectory)
      : gameDirectory;
    await fs.mkdir(workingDirectory, { recursive: true });
    return {
      argumentsList: [...jvmArguments, metadata.mainClass, ...gameArguments],
      gameDirectory: workingDirectory,
      javaExecutable,
      mainClass: metadata.mainClass,
      nativesDirectory,
      profileId: validatedId,
      requiredJavaVersion: metadata.javaVersion?.majorVersion
    };
  } catch (error) {
    await fs.rm(nativesDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

class MinecraftLauncher {
  constructor({ gameDirectory, spawnProcess = spawn, findJava, javaRuntime } = {}) {
    this.gameDirectory = gameDirectory;
    this.spawnProcess = spawnProcess;
    this.findJava = findJava;
    this.javaRuntime = javaRuntime ?? new ManagedJavaRuntime({
      gameDirectory,
      extractArchive: extractNativeArchive
    });
    this.activeGames = new Map();
  }

  async launch({
    profileId,
    targetId = profileId,
    instanceDirectory,
    account,
    memoryMb,
    javaPath,
    authlibInjector
  }, onStatus = () => {}) {
    const validatedId = validateProfileId(profileId);
    const launchTargetId = String(targetId ?? validatedId);
    const existing = this.activeGames.get(launchTargetId);
    if (existing && existing.exitCode === null) throw new Error(`${launchTargetId} 已经在运行中`);

    onStatus({ phase: 'preparing', profileId: validatedId, targetId: launchTargetId });
    const findJava = this.findJava ?? ((explicitPath, requiredMajorVersion) => (
      this.javaRuntime.resolve(explicitPath, requiredMajorVersion, (progress) => {
        onStatus({
          phase: 'java',
          profileId: validatedId,
          targetId: launchTargetId,
          ...progress
        });
      })
    ));
    const prepared = await prepareLaunch({
      gameDirectory: this.gameDirectory,
      profileId: validatedId,
      account,
      memoryMb,
      javaPath,
      instanceDirectory,
      authlibInjector,
      findJava
    });
    onStatus({
      phase: 'launching',
      profileId: validatedId,
      targetId: launchTargetId,
      requiredJavaVersion: prepared.requiredJavaVersion
    });

    let child;
    let started = false;
    try {
      child = this.spawnProcess(prepared.javaExecutable, prepared.argumentsList, {
        cwd: prepared.gameDirectory,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.once('close', async (code, signal) => {
        await fs.rm(prepared.nativesDirectory, { recursive: true, force: true }).catch(() => {});
        if (!started) return;
        this.activeGames.delete(launchTargetId);
        onStatus({
          phase: 'exited',
          profileId: validatedId,
          targetId: launchTargetId,
          code,
          signal
        });
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
    } catch (error) {
      await fs.rm(prepared.nativesDirectory, { recursive: true, force: true }).catch(() => {});
      throw new Error(`无法启动 Java：${error.message}`);
    }

    started = true;
    this.activeGames.set(launchTargetId, child);
    child.unref?.();
    onStatus({
      phase: 'running',
      profileId: validatedId,
      targetId: launchTargetId,
      pid: child.pid
    });
    return {
      javaExecutable: prepared.javaExecutable,
      pid: child.pid,
      profileId: validatedId,
      targetId: launchTargetId,
      requiredJavaVersion: prepared.requiredJavaVersion
    };
  }
}

module.exports = {
  DEFAULT_FEATURES,
  MinecraftLauncher,
  expandArgumentEntries,
  extractNativeArchive,
  launchVariables,
  libraryArtifactPath,
  mergeLibraries,
  mergeMetadata,
  prepareLaunch,
  readVersionMetadata,
  replaceVariables,
  ruleMatches,
  rulesAllow,
  splitLegacyArguments
};
