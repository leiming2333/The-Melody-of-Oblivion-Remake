
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('launcherEnvironment', {
  versions: Object.freeze({
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node
  }),
  windowControls: Object.freeze({
    minimize: () => ipcRenderer.send('window:minimize'),
    close: () => ipcRenderer.send('window:close')
  }),
  files: Object.freeze({
    getPath: (file) => webUtils.getPathForFile(file)
  }),
  minecraft: Object.freeze({
    listVersions: (options = {}) => ipcRenderer.invoke('minecraft:list-versions', options),
    listLocalVersions: () => ipcRenderer.invoke('minecraft:list-local-versions'),
    inspectModpack: (filePath) => ipcRenderer.invoke('minecraft:inspect-modpack', filePath),
    installModpack: (filePath, options = {}) => ipcRenderer.invoke('minecraft:install-modpack', filePath, options),
    downloadVersion: (versionId) => ipcRenderer.invoke('minecraft:download-version', versionId),
    listLoaders: (gameVersion, loaderType, options = {}) => ipcRenderer.invoke(
      'minecraft:list-loaders',
      { gameVersion, loaderType, ...options }
    ),
    installLoader: (request) => ipcRenderer.invoke('minecraft:install-loader', request),
    cancelDownload: () => ipcRenderer.invoke('minecraft:cancel-download'),
    verifyVersion: (versionId) => ipcRenderer.invoke('minecraft:verify-version', versionId),
    deleteVersion: (profileId) => ipcRenderer.invoke('minecraft:delete-version', profileId),
    launchVersion: (profileId) => ipcRenderer.invoke('minecraft:launch-version', profileId),
    openDirectory: () => ipcRenderer.invoke('minecraft:open-directory'),
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
    selectJava: () => ipcRenderer.invoke('settings:select-java')
  }),
  accounts: Object.freeze({
    getState: () => ipcRenderer.invoke('accounts:get-state'),
    addOffline: (playerName, skinModel = 'steve') => (
      ipcRenderer.invoke('accounts:add-offline', playerName, skinModel)
    ),
    beginMicrosoft: () => ipcRenderer.invoke('accounts:begin-microsoft'),
    completeMicrosoft: (sessionId) => ipcRenderer.invoke('accounts:complete-microsoft', sessionId),
    copyMicrosoftCode: (code) => ipcRenderer.invoke('accounts:copy-microsoft-code', code),
    cancelMicrosoft: (sessionId) => ipcRenderer.invoke('accounts:cancel-microsoft', sessionId),
    loginLittleSkin: (username, password) => (
      ipcRenderer.invoke('accounts:login-littleskin', username, password)
    ),
    selectLittleSkinProfile: (sessionId, profileId) => (
      ipcRenderer.invoke('accounts:select-littleskin-profile', sessionId, profileId)
    ),
    onMicrosoftProgress: (callback) => {
      const listener = (_event, progress) => callback(progress);
      ipcRenderer.on('accounts:microsoft-progress', listener);
      return () => ipcRenderer.removeListener('accounts:microsoft-progress', listener);
    },
    select: (accountId) => ipcRenderer.invoke('accounts:select', accountId),
    setSkinModel: (accountId, skinModel) => (
      ipcRenderer.invoke('accounts:set-skin-model', accountId, skinModel)
    ),
    refreshSkin: (accountId) => ipcRenderer.invoke('accounts:refresh-skin', accountId),
    remove: (accountId) => ipcRenderer.invoke('accounts:remove', accountId)
  })
});
