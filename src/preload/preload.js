
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invokeTask(channel, ...args) {
  // Keep failures as data through both IPC and contextBridge. A rejected Error
  // loses its custom fields at either boundary; the renderer restores it there.
  return ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('launcherEnvironment', {
  diagnostics: Object.freeze({
    markStartup: (stage) => ipcRenderer.send('startup:stage', stage),
    whenWindowShown: () => ipcRenderer.invoke('startup:when-window-shown'),
    rendererReady: () => ipcRenderer.invoke('startup:renderer-ready'),
    copyError: (message) => ipcRenderer.invoke('diagnostics:copy-error', String(message)),
    reportError: (message) => ipcRenderer.send('diagnostics:error', String(message))
  }),
  windowControls: Object.freeze({
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close')
  }),
  shell: Object.freeze({
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url)
  }),
  files: Object.freeze({
    getPath: (file) => webUtils.getPathForFile(file)
  }),
  minecraft: Object.freeze({
    listVersions: (options = {}) => ipcRenderer.invoke('minecraft:list-versions', options),
    listLocalVersions: () => ipcRenderer.invoke('minecraft:list-local-versions'),
    getJavaRequirement: (targetId) => ipcRenderer.invoke('minecraft:get-java-requirement', targetId),
    detectJava: (options = {}) => ipcRenderer.invoke('minecraft:detect-java', options),
    downloadJava: (majorVersion, options = {}) => invokeTask('minecraft:download-java', majorVersion, options),
    cancelJavaDownload: () => ipcRenderer.invoke('minecraft:cancel-java-download'),
    onJavaDownloadProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('minecraft:java-download-progress', listener);
      return () => ipcRenderer.removeListener('minecraft:java-download-progress', listener);
    },
    inspectModpack: (filePath, options = {}) => invokeTask('minecraft:inspect-modpack', filePath, options),
    installModpack: (filePath, options = {}) => invokeTask('minecraft:install-modpack', filePath, options),
    resumeModpack: (sessionId, options = {}) => invokeTask('minecraft:resume-modpack', sessionId, options),
    selectMissingModpackFile: (sessionId, identity, options = {}) => invokeTask('minecraft:select-missing-modpack-file', sessionId, identity, options),
    discardModpackSession: (sessionId) => invokeTask('minecraft:discard-modpack-session', sessionId),
    downloadVersion: (versionId, options = {}) => invokeTask('minecraft:download-version', versionId, options),
    listLoaders: (gameVersion, loaderType, options = {}) => ipcRenderer.invoke(
      'minecraft:list-loaders',
      { gameVersion, loaderType, ...options }
    ),
    installLoader: (request) => invokeTask('minecraft:install-loader', request),
    cancelDownload: (options = {}) => invokeTask('minecraft:cancel-download', options),
    verifyVersion: (versionId) => ipcRenderer.invoke('minecraft:verify-version', versionId),
    deleteVersion: (profileId) => ipcRenderer.invoke('minecraft:delete-version', profileId),
    launchVersion: (profileId) => ipcRenderer.invoke('minecraft:launch-version', profileId),
    listMods: targetId => ipcRenderer.invoke('minecraft:list-mods', targetId),
    setModEnabled: (targetId, name, enabled) => ipcRenderer.invoke('minecraft:set-mod-enabled', targetId, name, enabled),
    importModFile: (targetId, filePath) => ipcRenderer.invoke('minecraft:import-mod-file', targetId, filePath),
    importMod: targetId => ipcRenderer.invoke('minecraft:import-mod', targetId),
    openDirectory: (targetId) => ipcRenderer.invoke('minecraft:open-directory', targetId),
    onDownloadProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('minecraft:download-progress', listener);
      return () => ipcRenderer.removeListener('minecraft:download-progress', listener);
    },
    onVerifyProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('minecraft:verify-progress', listener);
      return () => ipcRenderer.removeListener('minecraft:verify-progress', listener);
    },
    onLaunchStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('minecraft:launch-status', listener);
      return () => ipcRenderer.removeListener('minecraft:launch-status', listener);
    }
  }),
  settings: Object.freeze({
    getState: () => ipcRenderer.invoke('settings:get-state'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    detectJava: (options = {}) => ipcRenderer.invoke('settings:detect-java', options),
    selectJava: () => ipcRenderer.invoke('settings:select-java')
  }),
  updater: Object.freeze({
    getState: () => invokeTask('updater:get-state'),
    check: () => invokeTask('updater:check'),
    download: () => invokeTask('updater:download'),
    cancel: () => invokeTask('updater:cancel'),
    install: () => invokeTask('updater:install'),
    recover: (action) => invokeTask('updater:recover', action),
    listHistory: () => invokeTask('updater:list-history'),
    cleanupHistory: (ids) => invokeTask('updater:cleanup-history', ids),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('updater:state', listener);
      return () => ipcRenderer.removeListener('updater:state', listener);
    },
    onRequestShowSettings: (callback) => {
      const listener = () => callback();
      ipcRenderer.on('updater:show-settings', listener);
      return () => ipcRenderer.removeListener('updater:show-settings', listener);
    }
  }),
  accounts: Object.freeze({
    getState: () => ipcRenderer.invoke('accounts:get-state'),
    addOffline: (playerName, skinModel = 'steve') => (
      ipcRenderer.invoke('accounts:add-offline', playerName, skinModel)
    ),
    loginLittleSkin: (username, password) => (
      ipcRenderer.invoke('accounts:login-littleskin', username, password)
    ),
    selectLittleSkinProfile: (sessionId, profileId) => (
      ipcRenderer.invoke('accounts:select-littleskin-profile', sessionId, profileId)
    ),
    select: (accountId) => ipcRenderer.invoke('accounts:select', accountId),
    setSkinModel: (accountId, skinModel) => (
      ipcRenderer.invoke('accounts:set-skin-model', accountId, skinModel)
    ),
    rename: (accountId, newName) => ipcRenderer.invoke('accounts:rename', accountId, newName),
    refreshSkin: (accountId) => ipcRenderer.invoke('accounts:refresh-skin', accountId),
    remove: (accountId) => ipcRenderer.invoke('accounts:remove', accountId)
  })
});
