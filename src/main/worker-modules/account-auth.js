function createModule({ options, callMain }) {
  const accountStore = Object.fromEntries(['upsertMicrosoft', 'upsertYggdrasil', 'updateYggdrasilTexture',
    'getAccount', 'read'].map((method) => [method, (...args) => callMain(method, args)]));
  const manager = options.provider === 'microsoft'
    ? new (require('../accounts/microsoft-auth').MicrosoftAuthManager)({ accountStore, clientId: options.clientId })
    : new (require('../accounts/yggdrasil-auth').YggdrasilAuthManager)({ accountStore });
  return options.provider === 'microsoft' ? {
    begin: (ownerId) => manager.begin(ownerId),
    complete: (sessionId, ownerId, context) => manager.complete(sessionId, ownerId, context.onProgress),
    cancel: (sessionId, ownerId) => manager.cancel(sessionId, ownerId),
    cancelOwner: (ownerId) => manager.cancelOwner(ownerId),
    ensureAccount: (account) => manager.ensureAccount(account)
  } : {
    login: (username, password) => manager.login(username, password),
    ensureAccount: (account) => manager.ensureAccount(account)
  };
}

module.exports = { createModule };
