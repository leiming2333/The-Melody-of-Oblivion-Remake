const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const iconv = require('iconv-lite');

// Leave headroom for Windows quoting and the executable name.
const WINDOWS_COMMAND_LIMIT = 30000;

function commandLength(executable, args) {
  return [executable, ...args].reduce((length, value) => (
    length + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&').length + 3
  ), 0);
}

function quoteArgument(value) {
  if (String(value).includes('\0')) throw new Error('启动参数包含无效字符');
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function manifestJar(classpath) {
  // File URLs are ASCII after percent encoding, including spaces and Chinese
  // paths. Manifest continuation lines are limited by bytes, not characters.
  const header = `Class-Path: ${classpath.map((entry) => {
    const url = pathToFileURL(path.resolve(entry)).href;
    return /[\\/]$/.test(entry) && !url.endsWith('/') ? `${url}/` : url;
  }).join(' ')}`;
  const lines = [];
  for (let offset = 0; offset < header.length;) {
    const width = offset ? 69 : 70;
    lines.push(`${offset ? ' ' : ''}${header.slice(offset, offset + width)}`);
    offset += width;
  }
  const content = Buffer.from(`Manifest-Version: 1.0\r\n${lines.join('\r\n')}\r\n\r\n`, 'ascii');
  const name = Buffer.from('META-INF/MANIFEST.MF');
  const checksum = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + content.length, 16);
  return Buffer.concat([local, name, content, central, name, end]);
}

function argumentEncodingError(encoding) {
  return Object.assign(new Error(`Java 参数文件无法使用当前系统编码${encoding ? `（${encoding}）` : ''}完整表示中文或其他字符，请将游戏目录移到当前系统可表示的路径后重试`), {
    code: 'ARGUMENT_ENCODING_UNSUPPORTED', phase: 'arguments', retryable: false
  });
}

function encodeArgumentFile(content, filePath, javaDetails) {
  const ascii = /^[\x00-\x7f]*$/;
  const encoding = javaDetails?.nativeEncoding ?? javaDetails?.fileEncoding;
  if (ascii.test(content) && ascii.test(filePath)) return Buffer.from(content, 'ascii');
  if (!encoding || !iconv.encodingExists(encoding)) throw argumentEncodingError(encoding);
  const encoded = iconv.encode(content, encoding);
  // iconv substitutes '?' for characters unavailable in legacy code pages.
  // Reject that substitution, including an unrepresentable @file path.
  if (iconv.decode(encoded, encoding) !== content
      || iconv.decode(iconv.encode(filePath, encoding), encoding) !== filePath) {
    throw argumentEncodingError(encoding);
  }
  return encoded;
}

function commandTooLong() {
  return Object.assign(new Error('启动参数超过 Windows 长度限制，请缩短游戏目录路径，或选择兼容的新版本 Java'),
    { code: 'COMMAND_LINE_TOO_LONG', phase: 'arguments', retryable: false });
}

async function prepareJavaArguments({ javaExecutable, argumentsList, requiredJavaVersion,
  directory, javaDetails, jvmArgumentCount, platform = process.platform }) {
  if (platform !== 'win32' || commandLength(javaExecutable, argumentsList) < WINDOWS_COMMAND_LIMIT) {
    return argumentsList;
  }
  if (requiredJavaVersion >= 9) {
    const file = path.join(directory, 'arguments.txt');
    const count = Number.isInteger(jvmArgumentCount) && jvmArgumentCount >= 0
      ? Math.min(argumentsList.length, jvmArgumentCount) : argumentsList.length;
    const nativeArguments = [`@${file}`, ...argumentsList.slice(count)];
    if (commandLength(javaExecutable, nativeArguments) >= WINDOWS_COMMAND_LIMIT) throw commandTooLong();
    const content = `${argumentsList.slice(0, count).map(quoteArgument).join('\n')}\n`;
    // The Windows Java launcher reads @files using the native code page, even
    // when a newer VM defaults file.encoding to UTF-8. Preserve the original
    // classpath: modern mod loaders can inspect java.class.path themselves.
    await fs.writeFile(file, encodeArgumentFile(content, file, javaDetails), { mode: 0o600, flag: 'wx' });
    return nativeArguments;
  }
  const args = [...argumentsList];
  const classpathIndex = args.findIndex((arg) => arg === '-cp' || arg === '-classpath');
  if (classpathIndex >= 0 && args[classpathIndex + 1]) {
    const entries = args[classpathIndex + 1].split(';');
    // Keep each manifest's Class-Path header below the Java 8 header limit.
    const files = [];
    let chunk = [];
    let length = 0;
    for (let entry of entries) {
      // Directory entries need a trailing slash in a manifest Class-Path.
      try { if ((await fs.stat(entry)).isDirectory()) entry = `${entry}${path.sep}`; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const size = pathToFileURL(path.resolve(entry)).href.length + 1;
      if (length + size > 50000 && chunk.length) {
        files.push(chunk); chunk = []; length = 0;
      }
      chunk.push(entry); length += size;
    }
    if (chunk.length) files.push(chunk);
    const jars = [];
    for (const [index, group] of files.entries()) {
      const jar = path.join(directory, `classpath-${index}.jar`);
      await fs.writeFile(jar, manifestJar(group), { mode: 0o600, flag: 'wx' });
      jars.push(jar);
    }
    args[classpathIndex + 1] = jars.join(';');
    if (commandLength(javaExecutable, args) < WINDOWS_COMMAND_LIMIT) return args;
  }
  throw commandTooLong();
}

module.exports = { commandLength, quoteArgument, manifestJar, prepareJavaArguments, encodeArgumentFile };
