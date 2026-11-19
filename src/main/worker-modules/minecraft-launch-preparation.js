function createModule({ callMain }) {
  const { prepareLaunch } = require('../minecraft/launch-core');
  return {
    prepareLaunch: (_config, id, request, inspect) => prepareLaunch({ ...request,
      findJava: (...args) => callMain('prepareFindJava', [id, ...args]),
      inspectJava: inspect ? (...args) => callMain('prepareInspectJava', [id, ...args]) : undefined,
      verifyFiles: (profile) => callMain('prepareVerifyFiles', [id, profile])
    })
  };
}
module.exports = { createModule };
