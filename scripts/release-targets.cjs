'use strict';

const prefix = 'The-Melody-of-Oblivion-Remake';
const targets = [
  ['windows-x64', 'win32', 'x64', 'windows-2022', 'windows-2022', 'exe'],
  ['windows-ia32', 'win32', 'ia32', 'windows-2022', 'windows-2022', 'exe'],
  ['windows-arm64', 'win32', 'arm64', 'windows-11-arm', 'windows-11-arm', 'exe'],
  ['linux-x64', 'linux', 'x64', 'ubuntu-24.04', 'ubuntu-24.04', 'AppImage'],
  ['linux-arm64', 'linux', 'arm64', 'ubuntu-24.04-arm', 'ubuntu-24.04-arm', 'AppImage'],
  ['linux-armv7l', 'linux', 'armv7l', 'ubuntu-24.04', null, 'AppImage'],
  ['macos-x64', 'darwin', 'x64', 'macos-15-intel', 'macos-15-intel', 'zip'],
  ['macos-arm64', 'darwin', 'arm64', 'macos-15', 'macos-15', 'zip']
].map(([id, platform, arch, runner, smokeRunner, extension]) => ({
  id, platform, arch, runner, smokeRunner, extension,
  artifact: `dist-${id}`,
  filename: `${prefix}-${{ win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[platform]}-${arch}.${extension}`,
  output: `release/build/${id}`
}));

function matrix(smoke = false) {
  return { include: targets.filter(target => !smoke || target.smokeRunner).map(target => ({
    ...target, runner: smoke ? target.smokeRunner : target.runner
  })) };
}

if (require.main === module) {
  const smoke = process.argv.includes('--smoke');
  console.log(JSON.stringify(matrix(smoke)));
}

module.exports = { targets, matrix };
