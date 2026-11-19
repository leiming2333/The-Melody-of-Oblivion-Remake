const { SettingsStore } = require('../settings/settings-store');
const { prepareStore } = require('../store-preparation');

function createModule({ options }) {
  const store = new SettingsStore(options.filePath);
  let prepared;
  const prepare = () => prepared ??= prepareStore(store).catch((error) => { prepared = undefined; throw error; });
  return {
    prepare,
    getState: async () => { await prepare(); return store.getState(); },
    update: async (patch) => { await prepare(); return store.update(patch); }
  };
}

module.exports = { createModule };
