const { deflateRawSync } = require('node:zlib');

// Minimal single-volume ZIP for tests. Entries are [name, bytes, method=0].
function zip(entries) {
  let offset = 0;
  const files = [], directory = [];
  for (const [filename, value, method = 0] of entries) {
    const name = Buffer.from(filename), content = Buffer.from(value);
    const compressed = method === 8 ? deflateRawSync(content) : content;
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    files.push(local, name, compressed); directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}

module.exports = { zip };
