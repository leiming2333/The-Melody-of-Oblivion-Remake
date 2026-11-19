const crypto = require('node:crypto');
const { UpdateManager } = require('../updater/update-manager');

function createModule({ options, callMain, emit }) {
  const startHelper = async ({ signal, record, store, platform, rollback, sourcePath }) => {
    const helperId = crypto.randomUUID();
    const cancel = () => { void callMain('cancelHelper', [helperId]).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) { const error = new Error('更新安装准备已取消'); error.name = 'AbortError'; throw error; }
      await callMain('startHelper', [{ helperId, record,
        store: store ? { filePath: store.filePath, records: store.records, persistent: store.persistent } : undefined,
        platform, rollback, sourcePath }]);
      return { kill: cancel };
    } finally { signal?.removeEventListener('abort', cancel); }
  };
  const app = { isPackaged: options.isPackaged, getVersion: () => options.version,
    getPath: (name) => options.paths[name],
    relaunch: () => callMain('relaunch'), quit: () => callMain('quit') };
  const manager = new UpdateManager({ app, parentPid: options.parentPid, env: options.env,
    platform: options.platform, arch: options.arch, startHelper, startLegacyHelper: startHelper,
    shell: { showItemInFolder: (target) => { void callMain('showItemInFolder', [target]).catch(() => {}); },
      trashItem: (target) => callMain('trashItem', [target]) },
    onStateChange: (state) => emit('state', state),
    onUpdateAvailable: (...args) => emit('available', args),
    onUpdateReady: (...args) => emit('ready', args)
  });
  return {
    initialize: async () => { await manager.initialize(); return manager.publicState(); },
    getState: () => manager.publicState(),
    check: (settings) => manager.check(settings),
    download: () => manager.download(),
    install: () => manager.install(),
    cancel: () => manager.cancel(),
    confirmHealthy: () => manager.confirmHealthy(),
    recover: (action) => manager.recover(action),
    listHistory: () => manager.listHistory(),
    cleanupHistory: (ids) => manager.cleanupHistory(ids)
  };
}

module.exports = { createModule };
