const { AccountStore } = require('../accounts/account-store');
const { prepareStore } = require('../store-preparation');

function createModule({ options, callMain }) {
  const store = new AccountStore(options.filePath, { secretCodec: {
    encode: (value) => callMain('encode', [value]),
    decode: (value) => callMain('decode', [value])
  } });
  let prepared;
  const prepare = () => prepared ??= prepareStore(store).catch((error) => { prepared = undefined; throw error; });
  const methods = ['getState', 'getCurrentAccount', 'getAccount', 'read', 'addOffline', 'upsertMicrosoft',
    'upsertYggdrasil', 'select', 'setSkinModel', 'renameAccount', 'remove', 'signOut', 'updateYggdrasilTexture', 'updateSkin'];
  const result = { prepare };
  for (const method of methods) result[method] = async (...args) => {
    args.pop(); // Request context belongs to the transport, not the store API.
    await prepare();
    return store[method](...args);
  };
  return result;
}

module.exports = { createModule };
