const path = require('node:path');
const { ModuleProcess } = require('../module-process');

class BackgroundAccounts {
  constructor(filePath, { secretCodec }) {
    this.filePath = filePath;
    this.process = new ModuleProcess({ moduleName: 'accounts',
      modulePath: path.join(__dirname, '../worker-modules/accounts.js'), options: { filePath },
      handlers: { encode: (value) => secretCodec.encode(value), decode: (value) => secretCodec.decode(value) } });
    for (const method of ['prepare', 'getState', 'getCurrentAccount', 'getAccount', 'read', 'addOffline',
      'upsertMicrosoft', 'upsertYggdrasil', 'updateYggdrasilTexture', 'select', 'setSkinModel', 'renameAccount',
      'remove', 'signOut']) this[method] = (...args) => this.process.invoke(method, args);
    this.skinProcess = new ModuleProcess({ moduleName: 'account-skins',
      modulePath: path.join(__dirname, '../worker-modules/account-skins.js'), handlers: {
        getAccount: (id) => this.getAccount(id),
        updateSkin: (...args) => this.process.invoke('updateSkin', args)
      } });
  }
  refreshSkin(accountId) { return this.skinProcess.invoke('refreshSkin', [accountId]); }
  dispose() { return Promise.all([this.skinProcess.dispose(), this.process.dispose()]); }
}

class BackgroundAccountAuth {
  constructor({ provider, clientId, getAccountStore }) {
    const methods = ['upsertMicrosoft', 'upsertYggdrasil', 'updateYggdrasilTexture', 'getAccount', 'read'];
    this.process = new ModuleProcess({ moduleName: `account-${provider}`,
      modulePath: path.join(__dirname, '../worker-modules/account-auth.js'), options: { provider, clientId },
      handlers: Object.fromEntries(methods.map((method) => [method, (...args) => getAccountStore()[method](...args)])) });
  }
  begin(ownerId) { return this.process.invoke('begin', [ownerId]); }
  complete(sessionId, ownerId, onProgress) { return this.process.invoke('complete', [sessionId, ownerId], { onProgress }); }
  cancel(sessionId, ownerId) { return this.process.invoke('cancel', [sessionId, ownerId]); }
  cancelOwner(ownerId) { return this.process.invoke('cancelOwner', [ownerId]).catch(() => {}); }
  login(username, password) { return this.process.invoke('login', [username, password]); }
  ensureAccount(account) { return this.process.invoke('ensureAccount', [account]); }
  dispose() { return this.process.dispose(); }
}

module.exports = { BackgroundAccounts, BackgroundAccountAuth };
