'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PATCH_MANIFEST_NAME = 'patch-manifest.json';
const PATCH_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const PATCH_MAX_BYTES = 128 * 1024 * 1024;
const MAX_PATCH_SOURCES = 3;
const MAX_PATCHES_PER_SOURCE = 8;
const MAX_PATCHES_TOTAL = 32;
const SHA256 = /^[a-f0-9]{64}$/i;
const TAG = /^v\d+\.\d+\.\d+$/;
let binpatchPromise;

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('启动器更新已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function normalizeTag(value) {
  const text = String(value ?? '').trim();
  const tag = text.startsWith('v') ? text : `v${text}`;
  return TAG.test(tag) ? tag : null;
}

function safeFileName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 255
    && !/[\\/\u0000-\u001f]/.test(value) && value !== '.' && value !== '..';
}

function normalizePatches(value, seen, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATCHES_PER_SOURCE) {
    throw failure(`${label}增量更新清单无效`, 'PATCH_MANIFEST_INVALID');
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || !safeFileName(entry.name)
      || !entry.name.endsWith('.patch') || seen.has(entry.name)
      || !safeFileName(entry.asset) || !SHA256.test(entry.sha256 ?? '')
      || !SHA256.test(entry.fromSha256 ?? '') || !SHA256.test(entry.toSha256 ?? '')
      || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > PATCH_MAX_BYTES
      || !Number.isSafeInteger(entry.toSize) || entry.toSize <= 0) {
      throw failure(`${label}增量更新清单包含无效条目`, 'PATCH_MANIFEST_INVALID');
    }
    seen.add(entry.name);
    return {
      name: entry.name,
      asset: entry.asset,
      target: typeof entry.target === 'string' && /^[a-z0-9-]+$/.test(entry.target) ? entry.target : null,
      size: entry.size,
      sha256: entry.sha256.toLowerCase(),
      fromSha256: entry.fromSha256.toLowerCase(),
      toSha256: entry.toSha256.toLowerCase(),
      toSize: entry.toSize
    };
  });
}

function readPatchManifest(value, { currentTag, targetTag } = {}) {
  const from = normalizeTag(value?.from);
  const to = normalizeTag(value?.to);
  if (value?.schemaVersion !== 1 || !from || !to || to !== normalizeTag(targetTag)
    || !Array.isArray(value.patches) || value.patches.length === 0
    || value.patches.length > MAX_PATCHES_PER_SOURCE) {
    throw failure('增量更新清单无效', 'PATCH_MANIFEST_INVALID');
  }
  const topPatches = normalizePatches(value.patches, new Set(), '');
  let sources;
  if (value.sources === undefined) {
    sources = [{ from, patches: topPatches }];
    if (currentTag && from !== normalizeTag(currentTag)) {
      throw failure('增量更新清单不适用于当前版本', 'PATCH_MANIFEST_INVALID');
    }
  } else {
    if (!Array.isArray(value.sources) || value.sources.length === 0
      || value.sources.length > MAX_PATCH_SOURCES) {
      throw failure('增量更新来源列表无效', 'PATCH_MANIFEST_INVALID');
    }
    const seenSources = new Set();
    const seenNames = new Set();
    let total = 0;
    sources = value.sources.map((source, index) => {
      const sourceFrom = normalizeTag(source?.from);
      if (!sourceFrom || seenSources.has(sourceFrom)) {
        throw failure('增量更新来源列表无效', 'PATCH_MANIFEST_INVALID');
      }
      seenSources.add(sourceFrom);
      const patches = normalizePatches(source.patches, new Set(), `来源 ${sourceFrom} `);
      total += patches.length;
      for (const patch of patches) {
        if (seenNames.has(patch.name)) throw failure('增量更新补丁重复', 'PATCH_MANIFEST_INVALID');
        seenNames.add(patch.name);
      }
      if (index === 0 && sourceFrom !== from) {
        throw failure('增量更新来源顺序无效', 'PATCH_MANIFEST_INVALID');
      }
      return { from: sourceFrom, patches };
    });
    if (total > MAX_PATCHES_TOTAL) throw failure('增量更新补丁过多', 'PATCH_MANIFEST_INVALID');
    if (JSON.stringify(sources[0].patches) !== JSON.stringify(topPatches)) {
      throw failure('增量更新兼容清单不匹配', 'PATCH_MANIFEST_INVALID');
    }
    if (currentTag && !sources.some(source => source.from === normalizeTag(currentTag))) {
      throw failure('增量更新清单不适用于当前版本', 'PATCH_MANIFEST_INVALID');
    }
  }
  return { schemaVersion: 1, from, to, patches: topPatches, sources };
}

function selectPatch(manifest, { from, assetName, target } = {}) {
  if (!manifest || !safeFileName(assetName)) return null;
  const tag = normalizeTag(from);
  if (!tag) return null;
  const source = (manifest.sources ?? []).find(entry => entry.from === tag)
    ?? (manifest.from === tag ? { patches: manifest.patches } : null);
  if (!source) return null;
  return source.patches.find((entry) => entry.asset === assetName
    && (!entry.target || !target || entry.target === target)) ?? null;
}

async function loadBinpatch() {
  if (binpatchPromise) return binpatchPromise;
  binpatchPromise = (async () => {
    // binpatch is ESM-only, so use the import condition instead of require.resolve.
    try { return await import('binpatch'); } catch (firstError) {
      // electron-builder keeps ESM helpers outside app.asar when unpacked.
      let appPath;
      try { appPath = require('electron').app.getAppPath(); } catch { appPath = null; }
      if (appPath && appPath.endsWith(`${path.sep}app.asar`)) {
        const unpacked = path.join(appPath.replace(/app\.asar$/, 'app.asar.unpacked'),
          'node_modules', 'binpatch', 'dist', 'index.js');
        try { return await import(pathToFileURL(unpacked).href); } catch { /* Report the original error. */ }
      }
      throw firstError;
    }
  })().catch((error) => {
    binpatchPromise = null;
    throw failure(`增量补丁组件无法加载：${error.message}`, 'PATCH_ENGINE_UNAVAILABLE');
  });
  return binpatchPromise;
}

async function applyDeltaPatch({ oldPath, patchData, destPath, expectedSize, expectedSha256,
  onBytes, signal } = {}) {
  throwIfAborted(signal);
  if (typeof oldPath !== 'string' || typeof destPath !== 'string'
    || path.resolve(oldPath) === path.resolve(destPath)
    || !safeFileName(path.basename(oldPath)) || !safeFileName(path.basename(destPath))
    || (!(patchData instanceof Uint8Array))
    || !Number.isSafeInteger(expectedSize) || expectedSize <= 0
    || !SHA256.test(expectedSha256 ?? '')) {
    throw failure('增量补丁参数无效', 'PATCH_ARGUMENT_INVALID');
  }
  if (patchData.byteLength <= 0 || patchData.byteLength > PATCH_MAX_BYTES) {
    throw failure('增量补丁大小无效', 'PATCH_SIZE_MISMATCH');
  }
  const { parsePatchHeader, applyPatchChainInMemory } = await loadBinpatch();
  let header;
  try { header = parsePatchHeader(patchData); }
  catch { throw failure('增量补丁格式无效', 'PATCH_INVALID'); }
  if (header.newSize !== expectedSize) {
    throw failure('增量补丁目标大小不匹配', 'PATCH_SIZE_MISMATCH');
  }
  throwIfAborted(signal);
  await fs.rm(destPath, { force: true }).catch(() => {});
  let actual;
  try {
    actual = await applyPatchChainInMemory(oldPath, [patchData], destPath, (bytes) => {
      if (signal?.aborted) return;
      onBytes?.(bytes);
    });
  } catch (error) {
    await fs.rm(destPath, { force: true }).catch(() => {});
    if (signal?.aborted) throwIfAborted(signal);
    throw failure(`增量补丁应用失败：${error.message}`, 'PATCH_APPLY_FAILED');
  }
  try {
    throwIfAborted(signal);
    const stat = await fs.stat(destPath);
    if (!stat.isFile() || stat.size !== expectedSize) {
      throw failure('增量补丁输出大小不匹配', 'PATCH_SIZE_MISMATCH');
    }
    if (String(actual).toLowerCase() !== expectedSha256.toLowerCase()) {
      throw failure('增量补丁输出 SHA-256 不匹配', 'PATCH_HASH_MISMATCH');
    }
    return { sha256: actual, size: stat.size };
  } catch (error) {
    await fs.rm(destPath, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  PATCH_MANIFEST_NAME,
  PATCH_MANIFEST_MAX_BYTES,
  PATCH_MAX_BYTES,
  MAX_PATCH_SOURCES,
  applyDeltaPatch,
  loadBinpatch,
  normalizeTag,
  readPatchManifest,
  safeFileName,
  selectPatch
};
