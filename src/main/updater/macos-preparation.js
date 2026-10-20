const path = require('node:path');
const { assertManagedAncestors } = require('./transaction-store');

function abortIfNeeded(signal) {
  if (signal?.aborted) throw Object.assign(new Error('更新安装准备已取消'), { name: 'AbortError', code: 'ABORT_ERR' });
}

async function assertBundleLinks(fileSystem, root, directory = root, signal) {
  for (const entry of await fileSystem.readdir(directory, { withFileTypes: true })) {
    abortIfNeeded(signal);
    const fullPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const real = await fileSystem.realpath(fullPath);
      if (!real.startsWith(`${await fileSystem.realpath(root)}${path.sep}`)) throw new Error('应用包含指向外部的符号链接');
    } else if (entry.isDirectory()) await assertBundleLinks(fileSystem, root, fullPath, signal);
  }
}

async function readMachOArchitectures(fileSystem, binary, signal) {
  const handle = await fileSystem.open(binary, 'r');
  const invalid = () => new Error('更新应用的可执行文件格式无效');
  try {
    const { size } = await handle.stat();
    const read = async (length, position = 0) => {
      abortIfNeeded(signal);
      if (!Number.isSafeInteger(position) || position < 0 || position + length > size) throw invalid();
      const bytes = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        abortIfNeeded(signal);
        const result = await handle.read(bytes, offset, length - offset, position + offset);
        if (!result.bytesRead) throw invalid();
        offset += result.bytesRead;
      }
      return bytes;
    };
    const cpuName = (cpu) => ({ 0x01000007: 'x64', 0x0100000c: 'arm64', 7: 'ia32', 12: 'arm' })[cpu];
    const thinCpu = (bytes) => {
      const magic = bytes.readUInt32BE(0);
      if ([0xfeedface, 0xfeedfacf].includes(magic)) return bytes.readUInt32BE(4);
      if ([0xcefaedfe, 0xcffaedfe].includes(magic)) return bytes.readUInt32LE(4);
      throw invalid();
    };
    const header = await read(8);
    const magic = header.readUInt32BE(0);
    if (![0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic)) {
      return [cpuName(thinCpu(header))].filter(Boolean);
    }
    const little = [0xbebafeca, 0xbfbafeca].includes(magic);
    const fat64 = [0xcafebabf, 0xbfbafeca].includes(magic);
    const uint32 = (bytes, offset) => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const uint64 = (bytes, offset) => Number(little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset));
    const count = uint32(header, 4);
    if (!count || count > 64) throw invalid();
    const entrySize = fat64 ? 32 : 20;
    const table = await read(8 + count * entrySize);
    const architectures = [];
    for (let index = 0; index < count; index++) {
      const entry = 8 + index * entrySize;
      const cpu = uint32(table, entry);
      const offset = fat64 ? uint64(table, entry + 8) : uint32(table, entry + 8);
      const sliceSize = fat64 ? uint64(table, entry + 16) : uint32(table, entry + 12);
      if (!Number.isSafeInteger(sliceSize) || sliceSize < 8 || offset < table.length || offset + sliceSize > size
        || thinCpu(await read(8, offset)) !== cpu) throw invalid();
      if (cpuName(cpu)) architectures.push(cpuName(cpu));
    }
    return [...new Set(architectures)];
  } finally { await handle.close(); }
}

async function prepareMacUpdate({ record, fileSystem, runCommand, arch, signal }) {
  abortIfNeeded(signal);
  const targetStat = await fileSystem.lstat(record.targetPath);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('当前应用位置无法自动替换');
  const targetParent = path.dirname(record.targetPath);
  // A real create/remove probe catches ACLs, read-only volumes and mounted DMGs.
  const probe = path.join(targetParent, `.melody-write-${record.id}`);
  try {
    await fileSystem.mkdir(probe);
    await fileSystem.rmdir(probe);
  } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) {
      error.code = 'MANUAL_INSTALL_REQUIRED';
      error.message = '应用所在目录不可写，请手动解压并替换旧版本';
    }
    throw error;
  }
  if (record.targetPath.includes('/AppTranslocation/') || record.targetPath.startsWith('/Volumes/')) {
    throw Object.assign(new Error('当前应用位于临时或磁盘映像位置，请手动安装到应用程序目录'), { code: 'MANUAL_INSTALL_REQUIRED' });
  }
  await assertManagedAncestors(fileSystem, record.stagingRoot, targetParent);
  await fileSystem.mkdir(record.stagingRoot, { recursive: true });
  const [parentStat, stagingStat] = await Promise.all([fileSystem.stat(targetParent), fileSystem.stat(record.stagingRoot)]);
  if (parentStat.dev !== stagingStat.dev) throw Object.assign(new Error('更新暂存目录与应用不在同一磁盘，请手动安装'), { code: 'MANUAL_INSTALL_REQUIRED' });
  await runCommand('/usr/bin/ditto', ['-x', '-k', record.downloadPath, record.stagingRoot], { signal });
  abortIfNeeded(signal);
  const entries = await fileSystem.readdir(record.stagingRoot, { withFileTypes: true });
  const bundles = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
  if (bundles.length !== 1 || entries.some((entry) => entry.name !== '__MACOSX' && entry.name !== bundles[0]?.name)) {
    throw new Error('更新压缩包必须包含唯一应用');
  }
  const bundle = path.join(record.stagingRoot, bundles[0].name);
  await assertBundleLinks(fileSystem, bundle, bundle, signal);
  const { stdout } = await runCommand('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents', 'Info.plist')], { signal });
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== 'com.melodyofoblivion.launcher'
    || String(info.CFBundleShortVersionString) !== record.toVersion
    || typeof info.CFBundleExecutable !== 'string'
    || !info.CFBundleExecutable || /[\\/]/.test(info.CFBundleExecutable)) throw new Error('更新应用标识或版本不匹配');
  const binary = path.join(bundle, 'Contents', 'MacOS', info.CFBundleExecutable);
  if (!(await readMachOArchitectures(fileSystem, binary, signal)).includes(arch)) throw new Error('更新应用架构不匹配');
  abortIfNeeded(signal);
  return bundle;
}

module.exports = { prepareMacUpdate, assertBundleLinks, readMachOArchitectures };
