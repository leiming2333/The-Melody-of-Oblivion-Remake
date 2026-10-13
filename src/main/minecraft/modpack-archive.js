const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const inflateRaw = promisify(zlib.inflateRaw);
const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 20000,
  maxDirectoryBytes: 16 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024
});

function invalidArchive() {
  return new Error('整合包压缩目录或文件头已损坏');
}

async function readRange(handle, offset, length, archiveSize) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || offset < 0 || length < 0 || offset + length > archiveSize) throw invalidArchive();
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
    if (!bytesRead) throw invalidArchive();
    read += bytesRead;
  }
  return buffer;
}

function archiveEntryPath(name) {
  const normalized = name.replaceAll('\\', '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (normalized.includes('\0') || /^[A-Za-z]:/.test(normalized)
    || segments.some((segment) => segment === '..')) {
    throw new Error('整合包包含不安全的文件路径');
  }
  return segments.join('/');
}

function selectManifest(entries) {
  const findAt = (prefix) => entries.find((entry) => entry.name === `${prefix}modrinth.index.json`)
    ?? entries.find((entry) => entry.name === `${prefix}manifest.json`);
  const root = findAt('');
  if (root) return root;
  // Match the installer: a pack may wrap its contents in one top-level directory.
  const directories = new Set(entries.filter((entry) => entry.name.includes('/'))
    .map((entry) => entry.name.split('/', 1)[0]));
  if (directories.size === 1) return findAt(`${[...directories][0]}/`);
  return undefined;
}

async function readModpackManifest(archivePath, limits = {}) {
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  const handle = await fs.open(archivePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('拖入的整合包文件无效');
    if (stat.size > bounds.maxArchiveBytes) throw new Error('压缩包过大，无法安全读取');
    if (stat.size < 22) throw invalidArchive();
    const tailOffset = Math.max(0, stat.size - 65557);
    const tail = await readRange(handle, tailOffset, stat.size - tailOffset, stat.size);
    let end = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50
        && offset + 22 + tail.readUInt16LE(offset + 20) === tail.length) {
        end = offset;
        break;
      }
    }
    if (end < 0) throw invalidArchive();
    const entryCount = tail.readUInt16LE(end + 10);
    const directorySize = tail.readUInt32LE(end + 12);
    const directoryOffset = tail.readUInt32LE(end + 16);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)
      || tail.readUInt16LE(end + 8) !== entryCount
      || entryCount === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
      throw new Error('整合包不支持多卷或 ZIP64 压缩格式');
    }
    if (entryCount > bounds.maxEntries) throw new Error('压缩包包含过多文件');
    if (directorySize > bounds.maxDirectoryBytes) throw new Error('整合包压缩目录过大');
    if (directoryOffset + directorySize !== tailOffset + end) throw invalidArchive();
    const directory = await readRange(handle, directoryOffset, directorySize, stat.size);
    const entries = [];
    const seen = new Set();
    let cursor = 0;
    let totalBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) {
        throw invalidArchive();
      }
      const flags = directory.readUInt16LE(cursor + 8);
      const method = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const uncompressedSize = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const recordSize = 46 + nameLength + directory.readUInt16LE(cursor + 30)
        + directory.readUInt16LE(cursor + 32);
      const localOffset = directory.readUInt32LE(cursor + 42);
      if (cursor + recordSize > directory.length || directory.readUInt16LE(cursor + 34)
        || localOffset + 30 > directoryOffset || compressedSize === 0xffffffff
        || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) throw invalidArchive();
      if (flags & 1) throw new Error('整合包不支持加密 ZIP 文件');
      if (method !== 0 && method !== 8) throw new Error(`整合包使用了不支持的压缩格式：${method}`);
      const rawName = directory.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      const name = archiveEntryPath(rawName);
      cursor += recordSize;
      if (rawName.replaceAll('\\', '/').endsWith('/') || !name) continue;
      if (seen.has(name)) throw new Error('整合包包含重复文件路径');
      seen.add(name);
      if (uncompressedSize > bounds.maxEntryBytes) throw new Error('压缩包中的单个文件过大');
      totalBytes += uncompressedSize;
      if (totalBytes > bounds.maxTotalBytes) throw new Error('压缩包解压后的总大小过大');
      entries.push({ name, rawName, flags, method, compressedSize, uncompressedSize, localOffset });
    }
    if (cursor !== directory.length) throw invalidArchive();
    const manifest = selectManifest(entries);
    if (!manifest) throw new Error('未找到 modrinth.index.json 或 CurseForge manifest.json');
    if (manifest.compressedSize > bounds.maxManifestBytes
      || manifest.uncompressedSize > bounds.maxManifestBytes) throw new Error('整合包清单过大');
    const header = await readRange(handle, manifest.localOffset, 30, directoryOffset);
    if (header.readUInt32LE(0) !== 0x04034b50
      || header.readUInt16LE(6) !== manifest.flags
      || header.readUInt16LE(8) !== manifest.method) throw invalidArchive();
    const localNameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const localName = await readRange(handle, manifest.localOffset + 30, localNameLength, directoryOffset);
    if (localName.toString('utf8') !== manifest.rawName) throw invalidArchive();
    const dataOffset = manifest.localOffset + 30 + localNameLength + extraLength;
    const compressed = await readRange(handle, dataOffset, manifest.compressedSize, directoryOffset);
    const content = manifest.method === 0 ? compressed : await inflateRaw(compressed, {
      maxOutputLength: bounds.maxManifestBytes
    });
    if (content.length !== manifest.uncompressedSize) throw invalidArchive();
    try {
      return { name: path.posix.basename(manifest.name), value: JSON.parse(content.toString('utf8')) };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`整合包清单已损坏：${path.posix.basename(manifest.name)}`);
      throw error;
    }
  } finally {
    await handle.close();
  }
}

module.exports = { readModpackManifest };
