// 从 app-icon.ico 提取 256x256 PNG 图像，生成 PNG 和 ICNS 图标
const fs = require('fs');
const path = require('path');

const assetsDir = path.join(__dirname, '..', 'src', 'renderer', 'assets');
const icoPath = path.join(assetsDir, 'app-icon.ico');
const pngPath = path.join(assetsDir, 'app-icon.png');
const icnsPath = path.join(assetsDir, 'app-icon.icns');

const buf = fs.readFileSync(icoPath);
const count = buf.readUInt16LE(4);

// 查找 256x256 图像
let target = -1;
for (let i = 0; i < count; i++) {
  const offset = 6 + i * 16;
  const w = buf.readUInt8(offset) || 256;
  const h = buf.readUInt8(offset + 1) || 256;
  if (w === 256 && h === 256) {
    target = i;
    break;
  }
}
if (target < 0) {
  console.error('找不到 256x256 图像');
  process.exit(1);
}

const dirOffset = 6 + target * 16;
const dataSize = buf.readUInt32LE(dirOffset + 8);
const dataOffset = buf.readUInt32LE(dirOffset + 12);

// 检查是否为 PNG（大端序魔数 89 50 4E 47）
const isPng = buf[dataOffset] === 0x89 && buf[dataOffset + 1] === 0x50
  && buf[dataOffset + 2] === 0x4E && buf[dataOffset + 3] === 0x47;

if (!isPng) {
  console.error('256x256 图像不是 PNG 格式，需要额外转换');
  process.exit(1);
}

// 直接提取 PNG 数据
const png = buf.slice(dataOffset, dataOffset + dataSize);
fs.writeFileSync(pngPath, png);
console.log('PNG 已生成:', pngPath, '(' + png.length + ' bytes)');

// 构建 ICNS（使用 ic09 类型：256x256 32-bit，支持 PNG 压缩）
const iconType = Buffer.from('ic09', 'ascii');
const iconLen = Buffer.alloc(4);
iconLen.writeUInt32BE(png.length + 8, 0);
const iconEntry = Buffer.concat([iconType, iconLen, png]);

const magic = Buffer.from('icns', 'ascii');
const totalLen = Buffer.alloc(4);
totalLen.writeUInt32BE(iconEntry.length + 8, 0);
const icns = Buffer.concat([magic, totalLen, iconEntry]);
fs.writeFileSync(icnsPath, icns);
console.log('ICNS 已生成:', icnsPath, '(' + icns.length + ' bytes)');
console.log('完成');
