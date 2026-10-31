const crypto = require('node:crypto');
const { validateProfileId } = require('./profile-id');

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function invalid(label, field) {
  const error = new Error(`${label}格式无效：${field}`);
  error.code = 'INVALID_MINECRAFT_METADATA';
  throw error;
}

function validateDownload(value, label) {
  if (!isObject(value)) invalid(label, '下载信息必须是对象');
  if (value.sha1 !== undefined && (typeof value.sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(value.sha1))) invalid(label, 'SHA-1');
  if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0)) invalid(label, '文件大小');
  for (const key of ['url', 'path', 'id']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key])) invalid(label, key);
  }
}

function validateRules(rules, label) {
  if (rules === undefined) return;
  if (!Array.isArray(rules)) invalid(label, 'rules 必须是数组');
  for (const rule of rules) {
    if (!isObject(rule) || !['allow', 'disallow'].includes(rule.action)) invalid(label, '规则');
    if (rule.os !== undefined && !isObject(rule.os)) invalid(label, 'os 规则');
    if (rule.features !== undefined && !isObject(rule.features)) invalid(label, 'features 规则');
    for (const key of ['name', 'version', 'arch']) {
      if (rule.os?.[key] !== undefined && typeof rule.os[key] !== 'string') invalid(label, `os.${key}`);
    }
    if (rule.features && Object.values(rule.features).some((required) => typeof required !== 'boolean')) invalid(label, 'features 规则');
  }
}

function validateVersionMetadata(value, expectedId) {
  const label = `游戏版本 ${expectedId ?? ''} 配置`;
  if (!isObject(value)) invalid(label, '配置必须是对象');
  for (const key of ['id', 'inheritsFrom', 'jar']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string') invalid(label, key);
      validateProfileId(value[key]);
    }
  }
  if (expectedId && value.id !== undefined && value.id !== expectedId) invalid(label, '目录与 ID 不一致');
  if (value.mainClass !== undefined && (typeof value.mainClass !== 'string' || !value.mainClass)) invalid(label, 'mainClass');
  if (value.minecraftArguments !== undefined && typeof value.minecraftArguments !== 'string') invalid(label, 'minecraftArguments');
  if (value.javaVersion !== undefined && (!isObject(value.javaVersion)
      || !Number.isInteger(value.javaVersion.majorVersion) || value.javaVersion.majorVersion < 1)) invalid(label, 'javaVersion');
  if (value.arguments !== undefined) {
    if (!isObject(value.arguments)) invalid(label, 'arguments');
    for (const kind of ['game', 'jvm']) {
      if (value.arguments[kind] === undefined) continue;
      if (!Array.isArray(value.arguments[kind])) invalid(label, `arguments.${kind}`);
      for (const entry of value.arguments[kind]) {
        if (typeof entry === 'string') continue;
        if (!isObject(entry) || !(typeof entry.value === 'string'
            || (Array.isArray(entry.value) && entry.value.every((item) => typeof item === 'string')))) invalid(label, `arguments.${kind}`);
        validateRules(entry.rules, label);
      }
    }
  }
  if (value.libraries !== undefined) {
    if (!Array.isArray(value.libraries)) invalid(label, 'libraries 必须是数组');
    for (const library of value.libraries) {
      if (!isObject(library) || typeof library.name !== 'string' || !library.name) invalid(label, '依赖库');
      validateRules(library.rules, label);
      if (library.natives !== undefined && (!isObject(library.natives)
          || Object.values(library.natives).some((classifier) => typeof classifier !== 'string'))) invalid(label, 'natives');
      if (library.extract !== undefined && (!isObject(library.extract)
          || (library.extract.exclude !== undefined && (!Array.isArray(library.extract.exclude)
            || library.extract.exclude.some((prefix) => typeof prefix !== 'string'))))) invalid(label, 'extract.exclude');
      if (library.downloads !== undefined) {
        if (!isObject(library.downloads)) invalid(label, '依赖下载信息');
        if (library.downloads.artifact !== undefined) validateDownload(library.downloads.artifact, label);
        if (library.downloads.classifiers !== undefined) {
          if (!isObject(library.downloads.classifiers)) invalid(label, '原生库下载信息');
          for (const download of Object.values(library.downloads.classifiers)) validateDownload(download, label);
        }
      }
    }
  }
  if (value.downloads !== undefined) {
    if (!isObject(value.downloads)) invalid(label, 'downloads');
    if (value.downloads.client !== undefined) validateDownload(value.downloads.client, label);
  }
  if (value.assetIndex !== undefined) {
    validateDownload(value.assetIndex, label);
    if (typeof value.assetIndex.id !== 'string') invalid(label, 'assetIndex.id');
    validateProfileId(value.assetIndex.id);
  }
  if (value.assets !== undefined) {
    if (typeof value.assets !== 'string') invalid(label, 'assets');
    validateProfileId(value.assets);
  }
  if (value.logging !== undefined) {
    if (!isObject(value.logging)) invalid(label, 'logging');
    if (value.logging.client !== undefined) {
      if (!isObject(value.logging.client)) invalid(label, 'logging.client');
      if (value.logging.client.argument !== undefined && typeof value.logging.client.argument !== 'string') invalid(label, 'logging.client.argument');
      if (value.logging.client.file !== undefined) {
        validateDownload(value.logging.client.file, label);
        if (value.logging.client.file.id !== undefined) validateProfileId(value.logging.client.file.id);
      }
    }
  }
  return value;
}

function validateAssetIndex(value) {
  if (!isObject(value) || !isObject(value.objects)) invalid('资源索引', 'objects 必须是对象');
  for (const [name, asset] of Object.entries(value.objects)) {
    if (!name || !isObject(asset) || typeof asset.hash !== 'string' || !/^[a-f0-9]{40}$/i.test(asset.hash)
        || !Number.isSafeInteger(asset.size) || asset.size < 0) invalid('资源索引', `资源 ${name}`);
  }
  for (const key of ['virtual', 'map_to_resources']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') invalid('资源索引', key);
  }
  return value;
}

function verifyJsonBytes(bytes, { sha1, size } = {}, label = '元数据') {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${label}缺少原始下载内容，无法校验`);
  if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || bytes.length !== size)) {
    throw new Error(`${label}文件大小校验失败`);
  }
  if (sha1 !== undefined && (typeof sha1 !== 'string' || !/^[a-f0-9]{40}$/i.test(sha1)
      || crypto.createHash('sha1').update(bytes).digest('hex') !== sha1.toLowerCase())) {
    throw new Error(`${label} SHA-1 校验失败`);
  }
  return bytes;
}

module.exports = { validateAssetIndex, validateVersionMetadata, verifyJsonBytes };
