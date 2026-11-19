const { ErrorLog } = require('../error-log');
const { exportDiagnosticsReport } = require('../diagnostics-report');

function createModule({ options, callMain }) {
  const errorLog = new ErrorLog(options.userData);
  const app = { isPackaged: options.isPackaged, getVersion: () => options.version,
    getPath: (name) => ({ userData: options.userData, home: options.home }[name]) };
  return {
    record: (message) => errorLog.record(message),
    async exportReport(filePath, message) {
      await errorLog.queue;
      return exportDiagnosticsReport({ app, getSettings: () => callMain('getSettings'), message,
        dialog: { showSaveDialog: async () => ({ canceled: false, filePath }) } });
    }
  };
}

module.exports = { createModule };
